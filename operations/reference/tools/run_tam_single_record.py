#!/usr/bin/env python3
"""Run one explicitly selected, checkpointed ARS BS TAM regrade.

This runner deliberately has no queue, polling loop, retry loop, browser work,
or concurrent model execution.  One invocation may claim one exact NetSuite
Internal ID, perform one complete reader pass and one independent complete
validator pass, publish through the canonical TAM coordination API, verify the
published record and event, persist the outcome, and exit.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import AbstractContextManager, ExitStack, contextmanager
from pathlib import Path
from datetime import datetime, timezone
from uuid import UUID
from typing import Any, BinaryIO, Callable

try:
    from tools import tam_record_core as core
    from tools import tam_navigation_bridge as navigation_bridge
    from tools import tam_public_context as public_context
except ModuleNotFoundError:  # Direct execution: python tools/<this-file>.py
    import tam_record_core as core
    import tam_navigation_bridge as navigation_bridge
    import tam_public_context as public_context


RUN_SLUG = "ars-bs-tam-current"
ACTOR_KEY = "codex-single-record-v1"
CONTROL_MODE = "checkpointed-single-record"
PARALLEL_CONTROL_MODE = "checkpointed-parallel-records"
PIPELINE_SLOT: int | None = None
CLAIM_LEASE_SECONDS = 1_800
POOL_ROOT = (
    core.WORKSPACE
    / "outputs"
    / "tam_refresh_2026-07-27"
    / "grading_pool_v9"
)
FINAL_ROOT = (
    core.WORKSPACE
    / "outputs"
    / "tam_refresh_2026-07-27"
    / "grading_final"
)
CHECKPOINT_PATH = POOL_ROOT / "single_record_checkpoint.json"
LOCK_PATH = POOL_ROOT / "single_record.lock"
ENV_PATH = core.PROJECT / ".env.local"
VERCEL_ENV_PATH = core.PROJECT / ".vercel" / ".env.production.local"
STAGER = core.WORKSPACE / "tools" / "stage_tam_final_grades.py"
PDF_INVENTORY = (
    core.WORKSPACE
    / "outputs"
    / "tam_refresh_2026-07-27"
    / "current_lead_records_v6"
    / "pdf_inventory"
    / "pdf_inventory.csv"
)
PDF_INVENTORY_SHA256 = (
    "d49e1fa53d6925bc2bfd1c5ace0425baf0493784f06a62bac4fd583ff506de3c"
)
PDF_INVENTORY_SUMMARY = PDF_INVENTORY.with_name("pdf_inventory_summary.json")
PDF_INVENTORY_SUMMARY_SHA256 = (
    "150499766df9ad39cc66451426cf561dcf3db7e04c5b4c325af806df106cd657"
)
ROUND_CONTEXT: dict[str, Any] | None = None
ACTIVE_REVIEW: dict[str, str] | None = None


def configure_canonical_round(path: Path | None, *, require_ready: bool = True) -> None:
    """Select a successor through the canonical contract, never a parallel queue."""
    global RUN_SLUG, POOL_ROOT, FINAL_ROOT, CHECKPOINT_PATH, ROUND_CONTEXT
    try:
        from tools.tam_grading_round import canonical_context_path, load_round_context
    except ModuleNotFoundError:
        from tam_grading_round import canonical_context_path, load_round_context
    selected = path or canonical_context_path()
    if selected is None:
        return
    try:
        context = load_round_context(selected, require_ready=require_ready)
        core.configure_round(context)
    except (RuntimeError, ValueError, KeyError, OSError) as error:
        raise RunnerBlocked(f"canonical grading round rejected: {error}") from error
    ROUND_CONTEXT = context
    RUN_SLUG = context["run_slug"]
    artifact_root = Path(context["artifact_root"])
    POOL_ROOT = artifact_root / "grading"
    FINAL_ROOT = artifact_root / "finals"
    CHECKPOINT_PATH = POOL_ROOT / "single_record_checkpoint.json"
    # SingleRunnerLock deliberately remains the existing global workflow lock,
    # so a legacy and successor process cannot grade concurrently.


class RunnerBlocked(RuntimeError):
    """A fail-closed, persisted blocker rather than a retry instruction."""


class HeartbeatRpcFetchFailed(RunnerBlocked):
    """The exact server-reported heartbeat RPC fetch failure, outcome unknown."""


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def exact_internal_id(value: str) -> str:
    internal_id = str(value).strip()
    if not internal_id.isascii() or not internal_id.isdigit():
        raise ValueError("--id must be one exact numeric NetSuite Internal ID")
    return internal_id


def load_control(path: Path = core.AUTOMATION_CONTROL) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    tam = value.get("tamRegrade")
    if not isinstance(tam, dict):
        raise RunnerBlocked("automation-control.json has no tamRegrade object")
    return tam


def require_enabled(path: Path = core.AUTOMATION_CONTROL, *, pipeline_slot: int | None = None) -> dict[str, Any]:
    tam = load_control(path)
    if tam.get("enabled") is not True:
        raise RunnerBlocked("TAM regrade is disabled in automation-control.json")
    if pipeline_slot is not None:
        if type(pipeline_slot) is not int or pipeline_slot not in (1, 2, 3):
            raise RunnerBlocked("parallel pipeline slot must be 1, 2, or 3")
        if ROUND_CONTEXT is None:
            raise RunnerBlocked("parallel pipelines require an explicit canonical successor round")
        if tam.get("mode") != PARALLEL_CONTROL_MODE or tam.get("maxConcurrentRecords") != 3:
            raise RunnerBlocked("parallel pipelines require the explicitly authorized three-record control mode")
        ref = tam.get("parallelAuthorization")
        if not isinstance(ref, dict) or not isinstance(ref.get("path"), str):
            raise RunnerBlocked("parallel execution authorization is missing")
        authorization_path = (core.WORKSPACE / ref["path"]).resolve()
        if not authorization_path.is_relative_to(core.WORKSPACE.resolve()):
            raise RunnerBlocked("parallel authorization escaped workspace")
        raw = authorization_path.read_bytes()
        if core.sha256_bytes(raw) != ref.get("sha256"):
            raise RunnerBlocked("parallel execution authorization changed")
        authorization = json.loads(raw)
        expected = {"approved": True, "runSlug": RUN_SLUG,
                    "contextSha256": ROUND_CONTEXT["context_sha256"],
                    "maxConcurrentRecords": 3, "eachRecordSerialReaderThenValidator": True}
        if (not isinstance(authorization, dict) or any(authorization.get(k) != v for k, v in expected.items())
                or authorization.get("approved") is not True
                or authorization.get("eachRecordSerialReaderThenValidator") is not True
                or type(authorization.get("maxConcurrentRecords")) is not int):
            raise RunnerBlocked("parallel execution authorization does not match this round")
        return tam
    if tam.get("mode") != CONTROL_MODE:
        raise RunnerBlocked(
            "TAM control mode must be checkpointed-single-record"
        )
    if tam.get("maxConcurrentRecords") != 1:
        raise RunnerBlocked("TAM maxConcurrentRecords must be exactly 1")
    return tam


class SingleRunnerLock(AbstractContextManager["SingleRunnerLock"]):
    """Fail-fast cross-process lock; the OS releases it if the process dies."""

    def __init__(self, path: Path = LOCK_PATH) -> None:
        self.path = path
        self.handle: BinaryIO | None = None

    def __enter__(self) -> "SingleRunnerLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            handle.close()
            raise RunnerBlocked(
                "another checkpointed TAM record invocation is already active"
            ) from error
        self.handle = handle
        return self

    def __exit__(self, *exc: object) -> None:
        if self.handle is None:
            return
        try:
            self.handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        finally:
            self.handle.close()
            self.handle = None


@contextmanager
def record_execution_lock(internal_id: str):
    """Three fixed slots, exact-ID exclusivity, and legacy/parallel exclusion."""
    slots = POOL_ROOT / "pipeline_locks"
    if PIPELINE_SLOT is None:
        # A serial invocation owns the global gate throughout its full record.
        # Reserving every slot also refuses an already-running parallel mode.
        with SingleRunnerLock(), ExitStack() as held:
            for slot in (1, 2, 3):
                held.enter_context(SingleRunnerLock(slots / f"slot-{slot}.lock"))
            yield
        return
    with ExitStack() as held:
        # Only local lock contention is retried, before any claim/model work.
        # This is a short admission gate, never an API or model retry.
        gate = None
        for attempt in range(101):
            candidate = SingleRunnerLock(LOCK_PATH)
            try:
                candidate.__enter__()
                gate = candidate
                break
            except RunnerBlocked:
                if attempt == 100:
                    raise
                time.sleep(0.05)
        assert gate is not None
        try:
            held.enter_context(SingleRunnerLock(slots / f"slot-{PIPELINE_SLOT}.lock"))
            held.enter_context(SingleRunnerLock(slots / "records" / f"{internal_id}.lock"))
        finally:
            gate.__exit__(None, None, None)
        yield


def configure_record_execution(internal_id: str, pipeline_slot: int | None) -> None:
    """Opt-in execution isolation; evidence and the canonical publish root stay shared."""
    global PIPELINE_SLOT, CHECKPOINT_PATH, ACTOR_KEY
    if pipeline_slot is None:
        return
    if ROUND_CONTEXT is None or type(pipeline_slot) is not int or pipeline_slot not in (1, 2, 3):
        raise RunnerBlocked("a configured successor and slot 1..3 are required")
    internal_id = exact_internal_id(internal_id)
    if internal_id not in ROUND_CONTEXT["evidence_index"]:
        raise RunnerBlocked("parallel worker exact ID is not in current membership")
    PIPELINE_SLOT = pipeline_slot
    CHECKPOINT_PATH = POOL_ROOT / "checkpoints" / f"{internal_id}.json"
    ACTOR_KEY = f"codex-tam-slot-{pipeline_slot}"


def require_recovery_slot(previous: dict[str, Any], internal_id: str) -> None:
    if (PIPELINE_SLOT is not None and previous.get("exactId") == internal_id
            and previous.get("status") in {"working", "pending_action", "publish_accepted"}
            and (previous.get("executionSlot") != PIPELINE_SLOT or previous.get("actorKey") != ACTOR_KEY)):
        raise RunnerBlocked("in-flight recovery must retain its exact execution slot and actor")


def record_codex_home() -> Path:
    if PIPELINE_SLOT is None:
        return core.prepare_codex_home()
    return core.prepare_codex_home(execution_scope=f"slot-{PIPELINE_SLOT}")


def checkpoint(
    internal_id: str,
    status: str,
    stage: str,
    **details: Any,
) -> dict[str, Any]:
    # Keep the opaque fencing token through every in-flight checkpoint so a
    # process restart can resume only its own still-live lease. Terminal
    # receipts intentionally drop it.
    if status != "complete" and "claimToken" not in details:
        existing = load_checkpoint()
        if (
            existing.get("exactId") == internal_id
            and isinstance(existing.get("claimToken"), str)
        ):
            details["claimToken"] = existing["claimToken"]
    existing = load_checkpoint()
    if (existing.get("exactId") == internal_id and existing.get("runSlug") == RUN_SLUG
            and existing.get("actorKey") == ACTOR_KEY):
        for key in ("claimIdentity", "claimGeneration", "coordinationPhase",
                    "publishRequestStarted", "heartbeatRecovery"):
            if key not in details and key in existing and (status != "complete" or key == "heartbeatRecovery"):
                details[key] = existing[key]
    value = {
        "schema": "tam-checkpointed-single-record",
        "version": 1,
        "runSlug": RUN_SLUG,
        "actorKey": ACTOR_KEY,
        "exactId": internal_id,
        "status": status,
        "stage": stage,
        "updatedAt": core.utc_now(),
        **({"executionSlot": PIPELINE_SLOT} if PIPELINE_SLOT is not None else {}),
        **(ACTIVE_REVIEW or {}),
        **details,
    }
    core.atomic_json(CHECKPOINT_PATH, value)
    return value


def env_file_value(path: Path, name: str) -> str:
    if not path.is_file():
        return ""
    for source_line in path.read_text(encoding="utf-8-sig").splitlines():
        line = source_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, separator, value = line.partition("=")
        if separator and key.strip() == name:
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            return value.strip()
    return ""


def require_reconciled_overlap_package(
    internal_id: str,
    package: dict[str, Any],
) -> None:
    """Accept a frozen-snapshot overlap only through its audited PDF inventory."""
    if core.sha256_file(PDF_INVENTORY_SUMMARY) != PDF_INVENTORY_SUMMARY_SHA256:
        raise RunnerBlocked("canonical PDF inventory summary SHA-256 drifted")
    if core.sha256_file(PDF_INVENTORY) != PDF_INVENTORY_SHA256:
        raise RunnerBlocked("canonical PDF inventory SHA-256 drifted")
    inventory_row: dict[str, str] | None = None
    with PDF_INVENTORY.open("r", encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if str(row.get("internal_id") or "").strip() == internal_id:
                inventory_row = row
                break
    if inventory_row is None:
        raise RunnerBlocked("lead package is absent from the audited PDF inventory")
    if str(inventory_row.get("valid") or "").strip().lower() != "true":
        raise RunnerBlocked("lead package is not valid in the audited PDF inventory")
    if str(inventory_row.get("sha256") or "").lower() != str(
        package["pdf_sha256"]
    ).lower():
        raise RunnerBlocked("lead package PDF differs from the audited inventory")
    if int(inventory_row.get("page_count") or 0) != int(package["pdf_pages"]):
        raise RunnerBlocked("lead package page count differs from the audited inventory")


def read_api_secrets() -> tuple[str, str]:
    def usable_secret(value: str) -> str:
        candidate = str(value or "").strip()
        if candidate.upper() in {"[SENSITIVE]", "[REDACTED]", "REDACTED"}:
            return ""
        return candidate

    # The seeded TAM board accepts only a dedicated agent token.  Deliberately
    # do not fall back to CRON_SECRET: this runner must never send a cron
    # credential to coordination or grade routes.
    agent_token = usable_secret(os.environ.get("CODEX_AGENT_TOKEN") or "")
    if not agent_token:
        agent_token = usable_secret(os.environ.get("AGENT_TOKEN") or "")
    if not agent_token:
        agent_token = usable_secret(env_file_value(ENV_PATH, "CODEX_AGENT_TOKEN"))
    if not agent_token:
        agent_token = usable_secret(env_file_value(ENV_PATH, "AGENT_TOKEN"))
    if not agent_token:
        agent_token = usable_secret(
            env_file_value(VERCEL_ENV_PATH, "CODEX_AGENT_TOKEN")
        )
    if not agent_token:
        agent_token = usable_secret(env_file_value(VERCEL_ENV_PATH, "AGENT_TOKEN"))
    if not agent_token:
        agent_token_path = core.PROJECT / ".vercel" / ".codex-agent-token"
        if agent_token_path.is_file():
            agent_token = usable_secret(
                agent_token_path.read_text(encoding="utf-8")
            )
    if not agent_token:
        raise RunnerBlocked(
            "Neither CODEX_AGENT_TOKEN nor AGENT_TOKEN is available for TAM coordination"
        )
    bypass_path = core.PROJECT / ".vercel" / ".automation-bypass"
    bypass = str(
        os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET") or ""
    ).strip()
    if not bypass and bypass_path.is_file():
        bypass = bypass_path.read_text(encoding="utf-8").strip()
    return agent_token, bypass


def request_json_once(
    method: str,
    route: str,
    agent_token: str,
    bypass: str,
    body: dict[str, Any] | None = None,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
) -> dict[str, Any]:
    """Make one bounded HTTP attempt. The caller persists any failure."""

    raw = None if body is None else canonical_bytes(body)
    headers = {"x-agent-token": agent_token, "x-agent-name": "codex"}
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    if raw is not None:
        headers["content-type"] = "application/json"
    request = urllib.request.Request(
        core.BASE_URL + route,
        data=raw,
        headers=headers,
        method=method,
    )
    try:
        with opener(request, timeout=90) as response:
            value = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read(4000).decode("utf-8", errors="replace")
        try:
            decoded_error = json.loads(detail)
        except (ValueError, TypeError):
            decoded_error = None
        if (method == "POST" and route == "/api/cron/tam-coordination"
                and isinstance(body, dict) and body.get("action") == "heartbeat"
                and body.get("status") == "working"
                and isinstance(body.get("claimToken"), str) and error.code == 409
                and decoded_error == {"error": "TAM actor/claim heartbeat failed: TypeError: fetch failed"}):
            raise HeartbeatRpcFetchFailed("heartbeat RPC fetch failed; acceptance unknown") from error
        raise RunnerBlocked(
            f"{route} returned HTTP {error.code}: {detail}"
        ) from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RunnerBlocked(
            f"{route} transport failed once: {type(error).__name__}: {error}"
        ) from error
    if not isinstance(value, dict):
        raise RunnerBlocked(f"{route} returned a non-object JSON response")
    return value


def coordination_post(
    secret: str,
    bypass: str,
    action: dict[str, Any],
) -> dict[str, Any]:
    return request_json_once(
        "POST",
        "/api/cron/tam-coordination",
        secret,
        bypass,
        action,
    )


def coordination_checkpoint(internal_id: str, **updates: Any) -> dict[str, Any]:
    """Preserve pending publication/artifact fields while recording heartbeat phase."""
    previous = load_checkpoint()
    if (previous.get("exactId") != internal_id or previous.get("runSlug") != RUN_SLUG
            or previous.get("actorKey") != ACTOR_KEY):
        raise RunnerBlocked("heartbeat checkpoint identity mismatch")
    value = {**previous, **updates, "updatedAt": core.utc_now()}
    core.atomic_json(CHECKPOINT_PATH, value)
    return value


def heartbeat_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise RunnerBlocked("heartbeat timestamp missing")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RunnerBlocked("heartbeat timestamp invalid") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise RunnerBlocked("heartbeat timestamp has no timezone")
    return parsed


def heartbeat_uuid(value: Any) -> str:
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError()
    except ValueError as error:
        raise RunnerBlocked("heartbeat identity UUID invalid") from error
    return value


def preclaim_run_identity(result: dict[str, Any], internal_id: str) -> str:
    """Use the existing actor-only ACK for run identity, never claim ownership."""
    actor = result.get("actor") if isinstance(result, dict) else None
    if (not isinstance(actor, dict) or "claim" not in result or result["claim"] is not None
            or actor.get("actor_key") != ACTOR_KEY or actor.get("status") != "working"
            or actor.get("current_work") != f"claim NetSuite ID {internal_id}"):
        raise RunnerBlocked("preclaim actor heartbeat acknowledgment mismatch")
    return heartbeat_uuid(actor.get("run_id"))


def claim_fence(record: dict[str, Any], internal_id: str, token: str) -> dict[str, Any]:
    """Validate only fields actually returned by the 0058 atomic claim RPC."""
    heartbeat_uuid(token)
    generation = record.get("claim_generation")
    if (record.get("netsuite_internal_id") != internal_id or record.get("pdf_status") != "verified"
            or record.get("grade_status") != "reading" or record.get("claim_actor") != ACTOR_KEY
            or record.get("last_actor") != ACTOR_KEY or record.get("claim_token") != token
            or type(generation) is not int or generation < 1):
        raise RunnerBlocked("atomic claim identity/state invalid")
    company = heartbeat_uuid(record.get("company_id"))
    seed = None
    if ROUND_CONTEXT is not None:
        seed = heartbeat_uuid(ROUND_CONTEXT.get("checkpoint_seed_id"))
        entry = (ROUND_CONTEXT.get("evidence_index") or {}).get(internal_id)
        if (ROUND_CONTEXT.get("run_slug") != RUN_SLUG or not isinstance(entry, dict)
                or entry.get("company_id") != company):
            raise RunnerBlocked("atomic claim differs from canonical round/company")
    started = heartbeat_time(record.get("claim_heartbeat_at"))
    expiry = heartbeat_time(record.get("claim_expires_at"))
    if expiry <= datetime.now(timezone.utc) or expiry <= started:
        raise RunnerBlocked("atomic claim lease expired or invalid")
    return {"runSlug": RUN_SLUG, "seedId": seed, "companyId": company,
            "exactId": internal_id, "actorKey": ACTOR_KEY, "claimGeneration": generation,
            "claimTokenSha256": hashlib.sha256(token.encode("utf-8")).hexdigest()}


def claim_identity(record: dict[str, Any], internal_id: str, token: str, run_id: str) -> dict[str, Any]:
    # Current admission is enforced by 0058 under the atomic claim row lock.
    # Seed/company expectations come from the already hash-validated local round.
    return {**claim_fence(record, internal_id, token), "runId": heartbeat_uuid(run_id)}


def verify_heartbeat_ownership_readback(record: dict[str, Any], baseline: dict[str, Any]) -> None:
    """A GET confirms the original fence; it cannot supply or replace ownership."""
    expected = {"run_id": baseline["runId"], "checkpoint_seed_id": baseline["seedId"],
                "company_id": baseline["companyId"], "netsuite_internal_id": baseline["exactId"],
                "claim_actor": baseline["actorKey"], "last_actor": baseline["actorKey"],
                "claim_generation": baseline["claimGeneration"], "grade_status": "reading", "pdf_status": "verified"}
    if (any(record.get(key) != value for key,value in expected.items())
            or record.get("is_current") is not True or record.get("membership_status") == "removed"
            or type(record.get("claim_generation")) is not int):
        raise RunnerBlocked("heartbeat ownership readback changed")
    started = heartbeat_time(record.get("claim_heartbeat_at"))
    expiry = heartbeat_time(record.get("claim_expires_at"))
    if expiry <= datetime.now(timezone.utc) or expiry <= started:
        raise RunnerBlocked("heartbeat ownership readback lease invalid")


def validate_heartbeat_ack(result: dict[str, Any], baseline: dict[str, Any], action: dict[str, Any]) -> None:
    actor, acknowledged = result.get("actor"), result.get("claim")
    if not isinstance(actor, dict) or not isinstance(acknowledged, dict):
        raise RunnerBlocked("heartbeat acknowledgment missing actor/claim")
    if (actor.get("run_id") != baseline["runId"] or actor.get("actor_key") != baseline["actorKey"]
            or actor.get("status") != action["status"] or actor.get("current_work") != action["currentWork"]
            or acknowledged.get("netsuite_internal_id") != baseline["exactId"]
            or acknowledged.get("claim_actor") != baseline["actorKey"]
            or type(acknowledged.get("claim_generation")) is not int
            or acknowledged.get("claim_generation") != baseline["claimGeneration"]):
        raise RunnerBlocked("heartbeat acknowledgment identity mismatch")
    start = heartbeat_time(acknowledged.get("claim_heartbeat_at"))
    expiry = heartbeat_time(acknowledged.get("claim_expires_at"))
    if expiry <= datetime.now(timezone.utc) or expiry <= start:
        raise RunnerBlocked("heartbeat acknowledgment lease invalid")


def heartbeat_claim_once_with_readback(secret: str, bypass: str, internal_id: str,
                                       action: dict[str, Any]) -> None:
    previous = load_checkpoint()
    baseline = previous.get("claimIdentity")
    if (not isinstance(baseline, dict) or baseline.get("runSlug") != RUN_SLUG
            or baseline.get("exactId") != internal_id or baseline.get("actorKey") != ACTOR_KEY
            or type(baseline.get("claimGeneration")) is not int or baseline["claimGeneration"] < 1
            or type(previous.get("claimGeneration")) is not int
            or baseline.get("claimGeneration") != previous.get("claimGeneration")
            or baseline.get("claimTokenSha256") != hashlib.sha256(action["claimToken"].encode("utf-8")).hexdigest()):
        raise RunnerBlocked("heartbeat atomic-claim baseline missing or changed")
    heartbeat_uuid(baseline.get("runId"))
    heartbeat_uuid(baseline.get("companyId"))
    if baseline.get("seedId") is not None:
        heartbeat_uuid(baseline["seedId"])
    if ROUND_CONTEXT is not None:
        entry = (ROUND_CONTEXT.get("evidence_index") or {}).get(internal_id)
        if (ROUND_CONTEXT.get("run_slug") != RUN_SLUG or baseline.get("seedId") != ROUND_CONTEXT.get("checkpoint_seed_id")
                or not isinstance(entry, dict) or baseline.get("companyId") != entry.get("company_id")):
            raise RunnerBlocked("heartbeat canonical round/company changed")
    prior = previous.get("heartbeatRecovery")
    if prior is not None and (not isinstance(prior, dict) or not isinstance(prior.get("claimIdentity"), dict)):
        raise RunnerBlocked("heartbeat recovery receipt malformed")
    if (isinstance(prior, dict) and prior["claimIdentity"] == baseline
            and prior.get("status") != "acknowledged"):
        raise RunnerBlocked("unresolved heartbeat recovery requires explicit reconciliation")
    coordination_checkpoint(internal_id, coordinationPhase="heartbeat_started")
    try:
        result = coordination_post(secret, bypass, action)
    except HeartbeatRpcFetchFailed:
        prior = previous.get("heartbeatRecovery")
        if prior is not None and not isinstance(prior, dict):
            raise RunnerBlocked("heartbeat recovery receipt malformed")
        if isinstance(prior, dict) and prior.get("claimIdentity") == baseline:
            raise RunnerBlocked("one heartbeat recovery already consumed for this claim")
        recovery = {"claimIdentity": baseline, "stage": action["metadata"]["stage"],
                    "failureClass": "rpc_fetch_failed_acceptance_unknown", "status": "readback_started",
                    "originalRequestSha256": hashlib.sha256(canonical_bytes(action)).hexdigest(),
                    "recoveryPostsStarted": 0}
        coordination_checkpoint(internal_id, heartbeatRecovery=recovery)
        query = urllib.parse.urlencode({"view": "records", "run": RUN_SLUG, "id": internal_id, "limit": "1"})
        response = request_json_once("GET", f"/api/cron/tam-coordination?{query}", secret, bypass)
        rows = response.get("records")
        if (type(response.get("total")) is not int or response["total"] != 1
                or not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict)):
            raise RunnerBlocked("heartbeat exact ownership readback malformed")
        verify_heartbeat_ownership_readback(rows[0], baseline)
        recovery = {**recovery, "status": "recovery_post_started", "recoveryPostsStarted": 1,
                    "readbackClaimHeartbeatAt": rows[0]["claim_heartbeat_at"],
                    "readbackClaimExpiresAt": rows[0]["claim_expires_at"]}
        coordination_checkpoint(internal_id, heartbeatRecovery=recovery)
        # One identical, SQL-token-fenced renewal only. No recursive recovery or generic retry.
        result = coordination_post(secret, bypass, action)
        validate_heartbeat_ack(result, baseline, action)
        coordination_checkpoint(internal_id, heartbeatRecovery={**recovery, "status": "acknowledged"},
                                coordinationPhase="heartbeat_confirmed")
        return
    validate_heartbeat_ack(result, baseline, action)
    coordination_checkpoint(internal_id, coordinationPhase="heartbeat_confirmed")


def heartbeat(
    secret: str,
    bypass: str,
    internal_id: str,
    status: str,
    stage: str,
    claim_token: str | None = None,
) -> dict[str, Any] | None:
    action: dict[str, Any] = {
        "action": "heartbeat",
        "runSlug": RUN_SLUG,
        "actorKey": ACTOR_KEY,
        "status": status,
        "currentWork": (
            None if status in {"idle", "complete"} else
            f"{stage} NetSuite ID {internal_id}"
        ),
        "metadata": {
            "runner": "checkpointed-single-record",
            "exactId": internal_id,
            "stage": stage,
            "modelConcurrency": 1,
            **({"modelConcurrencyScope": "one_exact_record", "maximumConcurrentRecordPipelines": 3}
               if PIPELINE_SLOT is not None else {}),
        },
    }
    if claim_token is not None:
        action.update({
            "netsuiteInternalId": internal_id,
            "claimToken": claim_token,
            "leaseSeconds": CLAIM_LEASE_SECONDS,
        })
    if claim_token is not None and status == "working":
        heartbeat_claim_once_with_readback(secret, bypass, internal_id, action)
    else:
        return coordination_post(secret, bypass, action)


def claim(
    secret: str,
    bypass: str,
    internal_id: str,
    *,
    include_hold: bool,
    claim_token: str | None = None,
) -> dict[str, Any]:
    action: dict[str, Any] = {
        "action": "claim",
        "runSlug": RUN_SLUG,
        "actorKey": ACTOR_KEY,
        "netsuiteInternalId": internal_id,
        "includeHold": include_hold,
        "leaseSeconds": CLAIM_LEASE_SECONDS,
    }
    if claim_token is not None:
        action["claimToken"] = claim_token
    result = coordination_post(
        secret,
        bypass,
        action,
    )
    record = result.get("record")
    if not isinstance(record, dict):
        raise RunnerBlocked("coordination claim returned no exact record")
    if str(record.get("netsuite_internal_id")) != internal_id:
        raise RunnerBlocked("coordination claim returned the wrong Internal ID")
    if record.get("grade_status") != "reading":
        raise RunnerBlocked("coordination claim did not enter reading state")
    if record.get("last_actor") != ACTOR_KEY:
        raise RunnerBlocked("coordination claim has the wrong actor")
    if record.get("claim_actor") != ACTOR_KEY:
        raise RunnerBlocked("coordination claim has the wrong lease actor")
    if not isinstance(record.get("claim_token"), str):
        raise RunnerBlocked("coordination claim returned no fencing token")
    claim_fence(record, internal_id, record["claim_token"])
    return record


def set_grade_status_once(
    secret: str,
    bypass: str,
    internal_id: str,
    claim_token: str,
    status: str,
    hold_reason: str | None = None,
) -> dict[str, Any]:
    action: dict[str, Any] = {
        "action": "grade_status",
        "runSlug": RUN_SLUG,
        "actorKey": ACTOR_KEY,
        "netsuiteInternalId": internal_id,
        "claimToken": claim_token,
        "status": status,
    }
    if hold_reason:
        action["holdReason"] = hold_reason[:2000]
    return coordination_post(secret, bypass, action)


def evidence_identity(internal_id: str, package: dict[str, Any]) -> dict[str, Any]:
    identity = {
        "runSlug": RUN_SLUG,
        "exactId": internal_id,
        "snapshotSha256": core.SNAPSHOT_SHA256,
        "membershipSha256": core.MEMBERSHIP_SHA256,
        "pdfSha256": package["pdf_sha256"],
        "pdfPageCount": package["pdf_pages"],
        "recordTextSha256": package["record_text_sha256"],
        "recordTextCharacters": len(package["record_text"]),
    }
    if ROUND_CONTEXT is not None:
        identity.update({
            "roundContextSha256": ROUND_CONTEXT["context_sha256"],
            "assessmentDate": ROUND_CONTEXT["assessment_date"],
            "rubricVersion": ROUND_CONTEXT["rubric_version"],
            "rubricSha256": ROUND_CONTEXT["rubric_sha256"],
            "captureSha256": core.sha256_file(package["capture_path"]),
            "capturedAt": package["capture"]["captured_at_utc"],
            "sourceSnapshotSha256": package["capture"]["snapshot_sha256"],
            "evidencePolicy": ROUND_CONTEXT["evidence_policy"],
        })
    if package.get("supplemental_company_context") is not None:
        supplemental_bytes = canonical_bytes(
            package["supplemental_company_context"]
        )
        identity["supplementalCompanyContextSha256"] = hashlib.sha256(
            supplemental_bytes
        ).hexdigest()
        identity["supplementalCompanyContextCharacters"] = len(
            supplemental_bytes
        )
    if package.get("identity_review") is not None:
        identity["reviewedFactsSha256"] = package["identity_review"]["factsSha256"]
    if package.get("evidence_navigation") is not None:
        identity["evidenceNavigationSha256"] = core.sha256_bytes(
            navigation_bridge.indexer.encoded(package["evidence_navigation"])
        )
    return identity


def _review_json(raw: bytes) -> dict[str, Any]:
    def unique(pairs):
        value = {}
        for key, item in pairs:
            if key in value:
                raise RunnerBlocked("duplicate review JSON key")
            value[key] = item
        return value
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise RunnerBlocked("review JSON must be an object")
    return value


def _review_ref(ref: Any, *, preserved: Path | None = None) -> tuple[Path, bytes]:
    if not isinstance(ref, dict) or set(ref) != {"path", "sha256"}:
        raise RunnerBlocked("invalid review artifact reference")
    digest = ref["sha256"]
    if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
        raise RunnerBlocked("invalid review artifact SHA")
    name = ref["path"]
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise RunnerBlocked("review reference must be workspace-relative")
    path = (core.WORKSPACE / name).resolve()
    if not path.is_relative_to(core.WORKSPACE.resolve()):
        raise RunnerBlocked("review reference escaped workspace")
    selected = preserved if preserved is not None and preserved.is_file() else path
    raw = selected.read_bytes()
    if core.sha256_bytes(raw) != digest:
        raise RunnerBlocked("review artifact hash mismatch")
    return path, raw


def _review_time(value: Any) -> None:
    if not isinstance(value, str) or "T" not in value:
        raise RunnerBlocked("review timestamp must be timezone-aware")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise RunnerBlocked("invalid review timestamp") from error
    if stamp.utcoffset() is None:
        raise RunnerBlocked("review timestamp must be timezone-aware")


def inherited_admission_path(internal_id: str) -> Path:
    return POOL_ROOT / "reviews" / internal_id / "inherited_admission.json"


def inherited_artifact_inventory(internal_id: str, previous: dict[str, Any]) -> list[str]:
    """Exact-ID grading metadata only; never open another lead's evidence."""
    found = ["checkpoint"] if previous else []
    for folder in ("holds", "published", "candidates", "reader_raw", "validator_raw", "validated", "logs"):
        for path in (POOL_ROOT / folder).glob(internal_id + ".*"):
            if path.is_file():
                found.append(path.relative_to(POOL_ROOT).as_posix())
    if (POOL_ROOT / "oversized" / internal_id).exists():
        found.append("oversized/" + internal_id)
    for name, field in (("publish_queue.jsonl", "netsuiteInternalId"), ("final_assessments.jsonl", "exact_id")):
        if find_jsonl_record(FINAL_ROOT / name, field, internal_id) is not None:
            found.append(name)
    return sorted(found)


def load_inherited_identity_review(review: dict[str, Any], path: Path, raw: bytes,
        internal_id: str, previous: dict[str, Any], revision_root: Path,
        approval_raw: bytes, source_documents: dict) -> dict[str, Any]:
    # v2 is exclusively the canonical inherited hold's first September assessment.
    prior = review["prior"]
    if not isinstance(prior, dict) or set(prior) != {"initialization", "seedManifest", "inheritedHolds"}:
        raise RunnerBlocked("inherited review requires canonical seed authority references")
    # Recheck live canonical local sources, not an arbitrary review-supplied copy.
    mission = _review_json((core.WORKSPACE / "stanley-source/stanley-main/config/tam-regrade-mission.json").read_bytes())
    active = mission.get("activeGradingRound") or {}
    seed_id = ROUND_CONTEXT["checkpoint_seed_id"]
    if (active.get("runSlug") != RUN_SLUG or active.get("checkpointSeedId") != seed_id
            or prior["initialization"] != active.get("initializationReadback")):
        raise RunnerBlocked("inherited initialization is not canonical")
    bound = {key: _review_ref(ref) for key, ref in prior.items()}
    initialized = _review_json(bound["initialization"][1])
    manifest = _review_json(bound["seedManifest"][1])
    old_holds = _review_json(bound["inheritedHolds"][1])
    board = initialized.get("board") or {}
    run = board.get("run") or {}
    seed = board.get("checkpointSeed") or {}
    source = manifest.get("sourceHashes") or {}
    counts = manifest.get("expectedCounts") or {}
    cohorts = manifest.get("cohortHashes") or {}
    heartbeat_uuid(seed_id)
    heartbeat_uuid(run.get("id"))
    if (initialized.get("verified") is not True or initialized.get("checkpoint_seed_id") != seed_id
            or initialized.get("count") != ROUND_CONTEXT["membership_count"]
            or run.get("slug") != RUN_SLUG or run.get("completed_checkpoint_seed_id") != seed_id
            or seed.get("id") != seed_id or seed.get("status") != "complete"
            or seed.get("run_id") != run.get("id")
            or prior["seedManifest"] != {"path": seed.get("manifest_object_path"), "sha256": seed.get("manifest_sha256")}
            or manifest.get("schema") != "tam-successor-checkpoint-manifest" or manifest.get("version") != 1
            or manifest.get("runSlug") != RUN_SLUG
            or source.get("membership") != core.MEMBERSHIP_SHA256
            or source.get("evidenceIndex") != ROUND_CONTEXT["evidence_index_reference"]["sha256"]
            or source.get("oldHolds") != prior["inheritedHolds"]["sha256"]
            or seed.get("expected_counts") != counts or seed.get("cohort_hashes") != cohorts
            or counts.get("currentTotal") != ROUND_CONTEXT["membership_count"]):
        raise RunnerBlocked("inherited completed seed authority differs")
    rows = old_holds.get("records")
    if (not isinstance(rows, list) or old_holds.get("offset") != 0
            or type(old_holds.get("total")) is not int or old_holds["total"] != len(rows)):
        raise RunnerBlocked("inherited hold metadata is incomplete")
    current = ROUND_CONTEXT["evidence_index"]
    selected = {}
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            raise RunnerBlocked("inherited hold metadata is malformed")
        key = row.get("netsuite_internal_id")
        if (not isinstance(key, str) or exact_internal_id(key) != key or key in seen
                or row.get("grade_status") != "hold" or row.get("is_current") is not True):
            raise RunnerBlocked("inherited hold metadata is not an exact old hold")
        seen.add(key)
        if key in current:
            reason = row.get("hold_reason")
            if (row.get("company_id") != current[key]["company_id"]
                    or not isinstance(reason, str) or not 0 < len(reason.strip()) <= 2000):
                raise RunnerBlocked("inherited hold company or reason differs")
            selected[key] = row
    # Initializer uses canonical membership order, not sorted IDs or index order.
    membership_raw = Path(ROUND_CONTEXT["membership_path"]).read_bytes()
    if core.sha256_bytes(membership_raw) != core.MEMBERSHIP_SHA256:
        raise RunnerBlocked("inherited canonical membership changed")
    ids = [str(row["Internal ID"]).strip() for row in csv.DictReader(membership_raw.decode("utf-8-sig").splitlines())]
    if len(ids) != len(set(ids)) or set(ids) != set(current):
        raise RunnerBlocked("inherited exact current membership differs")
    held_ids = [key for key in ids if key in selected]
    cohort_sha = core.sha256_bytes("".join(key + "\n" for key in held_ids).encode())
    if (internal_id not in selected or type(counts.get("activeHold")) is not int or counts.get("activeHold") != len(held_ids)
            or cohorts.get("activeHold") != cohort_sha):
        raise RunnerBlocked("record is not in the canonical inherited hold cohort")
    row = selected[internal_id]
    # Match initializer raw_json, which includes UTF-8 and a trailing newline.
    row_sha = core.sha256_bytes((json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode())
    context_sha = core.sha256_bytes(raw)
    admission = {"schema": "tam-inherited-first-assessment-admission", "version": 1,
        "runSlug": RUN_SLUG, "runId": run["id"], "seedId": seed_id,
        "exactId": internal_id, "companyId": review["companyId"], "recoveryCohort": "active_hold",
        "inheritedRowSha256": row_sha, "cohortSha256": cohort_sha,
        "reviewContextSha256": context_sha, "reviewedFactsSha256": review["factsSha256"],
        "actorKey": ACTOR_KEY, "executionSlot": PIPELINE_SLOT,
        "authority": prior, "initialGradingArtifacts": []}
    admission_sha = core.sha256_bytes(canonical_bytes(admission))
    admission_path = inherited_admission_path(internal_id)
    if admission_path.exists():
        if admission_path.read_bytes() != canonical_bytes(admission):
            raise RunnerBlocked("inherited admission cannot change context, facts, source or slot")
        if previous and (previous.get("exactId") != internal_id
                or previous.get("reviewContextSha256") != context_sha
                or previous.get("reviewedFactsSha256") != review["factsSha256"]
                or previous.get("inheritedAdmissionSha256") != admission_sha):
            raise RunnerBlocked("inherited recovery lost its exact admission binding")
        if previous.get("status") == "complete":
            raise RunnerBlocked("inherited first assessment already completed")
    elif inherited_artifact_inventory(internal_id, previous):
        raise RunnerBlocked("inherited first assessment already has September grading artifacts")
    binding = {"factsSha256": review["factsSha256"], "reviewContextSha256": context_sha,
               "inheritedAdmissionSha256": admission_sha}
    manifest_path = revision_root / "binding.json"
    if manifest_path.exists() and manifest_path.read_bytes() != canonical_bytes(binding):
        raise RunnerBlocked("same-facts inherited binding conflicts")
    result = {"document": review, "path": path, "raw": raw, "sha256": context_sha,
        "root": revision_root, "binding": binding, "priorBytes": bound, "approvalBytes": approval_raw,
        "sourceDocuments": list(source_documents.values()), "inheritedAdmission": admission,
        "inheritedHoldReason": row["hold_reason"].strip()}
    state_path = revision_root / "inherited_preflight.json"
    if state_path.exists():
        state = _review_json(state_path.read_bytes())
        first_claim = state.get("claimIdentity")
        last_claim = previous.get("claimIdentity")
        fence = {"runSlug": RUN_SLUG, "runId": run["id"], "seedId": seed_id,
                 "companyId": review["companyId"], "exactId": internal_id, "actorKey": ACTOR_KEY}
        if (state.get("admissionSha256") != admission_sha or state.get("status") != "claimed"
                or not isinstance(first_claim, dict) or not isinstance(last_claim, dict)
                or any(first_claim.get(k) != v or last_claim.get(k) != v for k, v in fence.items())
                or type(first_claim.get("claimGeneration")) is not int or first_claim["claimGeneration"] < 1
                or type(last_claim.get("claimGeneration")) is not int
                or last_claim["claimGeneration"] < first_claim["claimGeneration"]):
            raise RunnerBlocked("inherited first-claim preflight requires explicit reconciliation")
        proof = revision_root / "inherited_preflight_verified.json"
        if core.sha256_file(proof) != state.get("readbackSha256"):
            raise RunnerBlocked("inherited preflight readback proof changed")
        result["inheritedClaimed"] = True
    elif previous or inherited_artifact_inventory(internal_id, {}):
        raise RunnerBlocked("inherited artifacts lack first-claim proof")
    return result


def inherited_first_claim_preflight(review: dict[str, Any] | None, secret: str, bypass: str) -> None:
    if not review or "inheritedAdmission" not in review or review.get("inheritedClaimed"):
        return
    admission = review["inheritedAdmission"]
    state_path = review["root"] / "inherited_preflight.json"
    if state_path.exists():
        raise RunnerBlocked("inherited preflight cannot be automatically retried")
    state = {"admissionSha256": review["binding"]["inheritedAdmissionSha256"], "status": "read_started"}
    core.atomic_json(state_path, state)
    checkpoint(admission["exactId"], "pending_action", "inherited_metadata_read")
    row = published_record_readback(secret, bypass, admission["exactId"])
    expected = {"netsuite_internal_id": admission["exactId"], "company_id": admission["companyId"],
        "run_id": admission["runId"], "checkpoint_seed_id": admission["seedId"],
        "recovery_cohort": "active_hold", "grade_status": "hold", "pdf_status": "verified",
        "is_current": True, "hold_reason": review["inheritedHoldReason"], "validation_status": "pending"}
    absent = ("final_score", "grade_provenance_sha256", "grade_provenance_object_path",
              "grade_provenance_canonical_json", "validated_at", "graded_at", "published_at", "publication_origin",
              "claim_actor", "claim_started_at", "claim_heartbeat_at", "claim_expires_at")
    if (any(row.get(key) != value for key, value in expected.items())
            or row.get("is_current") is not True or row.get("membership_status") not in {"new", "overlap"}
            or (row.get("checkpoint_source_hashes") or {}).get("hold_file_sha256") != admission["inheritedRowSha256"]
            or row.get("grade_provenance") != {} or any(key not in row or row[key] is not None for key in absent)):
        raise RunnerBlocked("live inherited hold metadata or unpublished state differs")
    proof = {"admissionSha256": state["admissionSha256"], "verifiedAt": core.utc_now(),
             "expected": expected, "inheritedRowSha256": admission["inheritedRowSha256"],
             "noFinalProvenance": True, "responseSha256": core.sha256_bytes(canonical_bytes(row))}
    proof_path = review["root"] / "inherited_preflight_verified.json"
    with proof_path.open("xb") as stream:
        stream.write(canonical_bytes(proof)); stream.flush(); os.fsync(stream.fileno())
    state.update(status="verified", readbackSha256=core.sha256_file(proof_path))
    core.atomic_json(state_path, state)


def inherited_claim_transition(review: dict[str, Any] | None, status: str) -> None:
    if not review or "inheritedAdmission" not in review or review.get("inheritedClaimed"):
        return
    path = review["root"] / "inherited_preflight.json"
    state = _review_json(path.read_bytes())
    if state.get("status") != {"claim_started": "verified", "claimed": "claim_started"}[status]:
        raise RunnerBlocked("inherited first-claim journal is out of order")
    if state.get("admissionSha256") != review["binding"]["inheritedAdmissionSha256"]:
        raise RunnerBlocked("inherited first-claim admission changed")
    state["status"] = status
    if status == "claimed":
        state["claimIdentity"] = load_checkpoint()["claimIdentity"]
    core.atomic_json(path, state)
def load_identity_review(path: Path | None, internal_id: str, include_hold: bool,
                         previous: dict[str, Any]) -> dict[str, Any] | None:
    """Validate reviewed facts and old full-read receipts before any claim.

    Approval authenticates the locally reviewed bytes, not the truth of arbitrary
    web text. The operator must independently approve the factual attribution.
    """
    pending = previous.get("exactId") == internal_id and previous.get("status") in {
        "working", "pending_action", "publish_accepted"}
    review_bound = (previous.get("exactId") == internal_id and previous.get("status") != "complete"
                   and ("reviewedFactsSha256" in previous or "reviewContextSha256" in previous))
    if path is None:
        if inherited_admission_path(internal_id).exists() and previous.get("status") != "complete":
            raise RunnerBlocked("inherited assessment requires its same review context")
        if review_bound:
            raise RunnerBlocked("unfinished correction requires its same review context")
        return None
    if ROUND_CONTEXT is None or not include_hold:
        raise RunnerBlocked("review context requires canonical round and --include-hold")
    path = path.resolve()
    if not path.is_relative_to(core.WORKSPACE.resolve()):
        raise RunnerBlocked("review context escaped workspace")
    raw = path.read_bytes()
    if len(raw) > 100_000:
        raise RunnerBlocked("review context exceeds bounded factual input")
    review = _review_json(raw)
    required = {"schema", "version", "runSlug", "exactId", "companyId", "roundContextSha256",
                "baseEvidence", "prior", "facts", "factsSha256", "preparedBy", "approval"}
    if set(review) != required or review["schema"] != "tam-exact-identity-review" or type(review["version"]) is not int or review["version"] not in (1, 2):
        raise RunnerBlocked("unsupported identity review schema")
    entry = ROUND_CONTEXT["evidence_index"].get(internal_id)
    if (not entry or review["runSlug"] != RUN_SLUG or review["exactId"] != internal_id
            or review["companyId"] != entry["company_id"]
            or review["roundContextSha256"] != ROUND_CONTEXT["context_sha256"]):
        raise RunnerBlocked("review exact identity/context mismatch")
    base = review["baseEvidence"]
    expected = {"runSlug": RUN_SLUG, "exactId": internal_id,
                "snapshotSha256": core.SNAPSHOT_SHA256, "membershipSha256": core.MEMBERSHIP_SHA256,
                "roundContextSha256": ROUND_CONTEXT["context_sha256"],
                "pdfSha256": entry["pdf_sha256"], "pdfPageCount": entry["pdf_pages"],
                "recordTextSha256": entry["record_text_sha256"], "captureSha256": entry["capture_sha256"],
                "sourceSnapshotSha256": entry["source_snapshot_sha256"]}
    if not isinstance(base, dict) or "reviewedFactsSha256" in base or any(base.get(k) != v for k, v in expected.items()):
        raise RunnerBlocked("review frozen evidence mismatch")
    facts = review["facts"]
    if not isinstance(facts, list) or not 1 <= len(facts) <= 20:
        raise RunnerBlocked("review needs 1..20 independently reviewed attribution facts")
    facts_sha = core.sha256_bytes(canonical_bytes(facts))
    if review["factsSha256"] != facts_sha:
        raise RunnerBlocked("review facts SHA mismatch")
    revision_root = POOL_ROOT / "reviews" / internal_id / facts_sha[:16]
    source_documents = {}
    source_bytes = 0
    for fact in facts:
        if not isinstance(fact, dict) or set(fact) != {"statement", "sourceUrl", "source", "observedAt"}:
            raise RunnerBlocked("review facts may contain only factual attribution and source fields")
        if not isinstance(fact["statement"], str) or not 1 <= len(fact["statement"].strip()) <= 4000:
            raise RunnerBlocked("review fact is empty or oversized")
        if not isinstance(fact["sourceUrl"], str):
            raise RunnerBlocked("review source URL must be text")
        url = urllib.parse.urlsplit(fact["sourceUrl"])
        if url.scheme != "https" or not url.hostname or url.username or url.password:
            raise RunnerBlocked("review source must be an HTTPS public citation")
        _review_time(fact["observedAt"])
        _, source_raw = _review_ref(fact["source"])
        source_key = canonical_bytes(fact["source"])
        if source_key not in source_documents:
            source_bytes += len(source_raw)
            if len(source_raw) > 200_000 or source_bytes > 500_000:
                raise RunnerBlocked("review source text exceeds bounded full-read input")
            try:
                source_text = source_raw.decode("utf-8")
            except UnicodeDecodeError as error:
                raise RunnerBlocked("review sources require preserved UTF-8 text") from error
            source_documents[source_key] = {"source": fact["source"], "text": source_text}
    if len({canonical_bytes(f) for f in facts}) != len(facts):
        raise RunnerBlocked("duplicate review facts")
    _, approval_raw = _review_ref(review["approval"])
    approval = _review_json(approval_raw)
    binding = {k: v for k, v in review.items() if k != "approval"}
    approval_expected = {"schema": "tam-exact-identity-review-approval", "version": 1,
        "status": "approved_factual_identity_review", "runSlug": RUN_SLUG, "exactId": internal_id,
        "companyId": entry["company_id"], "roundContextSha256": ROUND_CONTEXT["context_sha256"],
        "factsSha256": facts_sha, "contextBindingSha256": core.sha256_bytes(canonical_bytes(binding)),
        "identityResolutionVerified": True, "noScoringInstructions": True}
    if (set(approval) != set(approval_expected) | {"reviewedBy", "reviewedAt"}
            or any(approval.get(k) != v for k, v in approval_expected.items())
            or type(approval.get("version")) is not int
            or approval.get("identityResolutionVerified") is not True or approval.get("noScoringInstructions") is not True
            or not isinstance(review["preparedBy"], str) or not review["preparedBy"].strip()
            or not isinstance(approval["reviewedBy"], str) or not approval["reviewedBy"].strip()
            or approval["reviewedBy"].strip().casefold() == review["preparedBy"].strip().casefold()):
        raise RunnerBlocked("independent factual review approval does not bind exact context")
    _review_time(approval["reviewedAt"])
    if review["version"] == 2:
        return load_inherited_identity_review(review, path, raw, internal_id, previous,
                                              revision_root, approval_raw, source_documents)
    prior = review["prior"]
    if not isinstance(prior, dict) or set(prior) != {"hold", "candidate", "candidateReceipt", "validator", "validatorReceipt"}:
        raise RunnerBlocked("review must bind all prior held artifacts and receipts")
    bound = {key: _review_ref(ref, preserved=revision_root / "original" / f"{key}.json")
             for key, ref in prior.items()}
    if bound["hold"][0] != (POOL_ROOT / "holds" / f"{internal_id}.json").resolve():
        raise RunnerBlocked("review prior hold is not the canonical exact hold")
    for role, folder, artifact in (("reader", "candidates", "candidate"), ("validator", "validator_raw", "validator")):
        artifact_path, artifact_raw = bound[artifact]
        receipt_path, receipt_raw = bound[artifact + "Receipt"]
        value = _review_json(artifact_raw)
        receipt = _review_json(receipt_raw)
        if (not artifact_path.is_relative_to((POOL_ROOT / folder).resolve())
                or not artifact_path.name.startswith(internal_id + ".")
                or receipt_path != artifact_receipt_path(artifact_path)
                or value.get("exact_id") != internal_id
                or receipt.get("schema") != "tam-full-evidence-model-artifact" or receipt.get("version") != 1
                or receipt.get("role") != role or receipt.get("evidence") != base
                or receipt.get("artifactSha256") != core.sha256_bytes(artifact_raw)
                or receipt.get("candidateSha256") != (prior["candidate"]["sha256"] if role == "validator" else None)
                or receipt.get("completeRawEvidenceCoverage") is not True
                or receipt.get("modelConcurrency") != 1):
            raise RunnerBlocked("review prior full-read receipt mismatch")
        if role == "validator" and value.get("validation_status") != "hold":
            raise RunnerBlocked("review requires a genuine prior validator hold")
    hold = _review_json(bound["hold"][1])
    if (hold.get("exact_id") != internal_id or (hold.get("validation") or {}).get("status") != "hold"
            or hold.get("candidate_file_sha256") != prior["candidate"]["sha256"]
            or hold.get("pdf_sha256") != entry["pdf_sha256"]
            or hold.get("record_text_sha256") != entry["record_text_sha256"]):
        raise RunnerBlocked("prior canonical hold does not bind candidate and evidence")
    context_sha = core.sha256_bytes(raw)
    if (pending or review_bound) and (previous.get("reviewedFactsSha256") != facts_sha or previous.get("reviewContextSha256") != context_sha):
        raise RunnerBlocked("unfinished correction cannot change its review context")
    # Same facts have one durable namespace; a new timestamp/approval cannot force
    # another read. Conflicting wrapper bytes stop instead of overwriting caches.
    manifest_path = revision_root / "binding.json"
    binding_receipt = {"factsSha256": facts_sha, "reviewContextSha256": context_sha}
    if manifest_path.is_file() and _review_json(manifest_path.read_bytes()) != binding_receipt:
        raise RunnerBlocked("same-facts correction binding conflicts")
    return {"document": review, "path": path, "raw": raw, "sha256": context_sha,
            "root": revision_root, "binding": binding_receipt, "priorBytes": bound,
            "approvalBytes": approval_raw, "sourceDocuments": list(source_documents.values())}


def preserve_identity_review(review: dict[str, Any], previous: dict[str, Any]) -> None:
    def exclusive(path: Path, raw: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.is_file():
            if path.read_bytes() != raw:
                raise RunnerBlocked("immutable correction before-image conflicts")
            return
        with path.open("xb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
    root = review["root"]
    for name, (_, raw) in review["priorBytes"].items():
        exclusive(root / "original" / f"{name}.json", raw)
    exclusive(root / "context.json", review["raw"])
    exclusive(root / "approval.json", review["approvalBytes"])
    for index, fact in enumerate(review["document"]["facts"]):
        exclusive(root / "sources" / f"{index:02d}.bin", _review_ref(fact["source"])[1])
    prior_checkpoint = root / "original" / "checkpoint.json"
    if not prior_checkpoint.exists():
        exclusive(prior_checkpoint, canonical_bytes(previous))
    for log in (POOL_ROOT / "logs").glob(review["document"]["exactId"] + ".single_*.log"):
        preserved_log = root / "original" / "logs" / log.name
        if not preserved_log.exists():
            exclusive(preserved_log, log.read_bytes())
    exclusive(root / "binding.json", canonical_bytes(review["binding"]))
    if "inheritedAdmission" in review:
        exclusive(inherited_admission_path(review["document"]["exactId"]), canonical_bytes(review["inheritedAdmission"]))


def attach_identity_review(package: dict[str, Any], internal_id: str, review: dict[str, Any] | None) -> None:
    if review is None:
        return
    if evidence_identity(internal_id, package) != review["document"]["baseEvidence"]:
        raise RunnerBlocked("fresh package differs from reviewed base evidence")
    def archived(relative: str, digest: str) -> dict[str, str]:
        return {"path": (review["root"] / relative).resolve().relative_to(core.WORKSPACE.resolve()).as_posix(), "sha256": digest}
    package["identity_review"] = {"schema": "tam-exact-identity-review-evidence", "version": 1,
        "exactId": internal_id, "companyId": review["document"]["companyId"],
        "factsSha256": review["document"]["factsSha256"], "facts": review["document"]["facts"],
        "context": archived("context.json", review["sha256"]),
        "approval": archived("approval.json", review["document"]["approval"]["sha256"]),
        "prior": {key: archived(f"original/{key}.json", ref["sha256"]) for key, ref in review["document"]["prior"].items()},
        "sourceArchives": [{"original": fact["source"], "preserved": archived(f"sources/{index:02d}.bin", fact["source"]["sha256"])}
                           for index, fact in enumerate(review["document"]["facts"])],
        "sourceDocuments": review["sourceDocuments"]}


def role_logs(internal_id: str, package: dict[str, Any]) -> Path:
    review = package.get("identity_review")
    if review is None:
        return POOL_ROOT / "logs"
    return POOL_ROOT / "reviews" / internal_id / review["factsSha256"][:16] / "logs"


def attach_live_company_context(
    internal_id: str,
    package: dict[str, Any],
) -> None:
    """The verified PDF/record package is the complete evidence source.

    The seeded lifecycle permits only coordination and tam-grade traffic.  Do
    not call the retired agent-read bridge to decorate evidence with mutable
    company fields.
    """
    if ROUND_CONTEXT is None:
        return
    entry = ROUND_CONTEXT["evidence_index"][internal_id]
    supplement = entry.get("supplement_path")
    if not supplement:
        return
    path = (core.WORKSPACE / supplement).resolve()
    if not path.is_relative_to(core.WORKSPACE.resolve()):
        raise RunnerBlocked("Supplement path escapes workspace")
    raw = path.read_bytes()
    if core.sha256_bytes(raw) != entry.get("supplement_sha256"):
        raise RunnerBlocked("Exact saved-search supplement changed")
    value = json.loads(raw)
    if str(value.get("internal_id")) != internal_id:
        raise RunnerBlocked("Saved-search supplement belongs to another lead")
    if not isinstance(value.get("table_rows"), list) or not value["table_rows"]:
        raise RunnerBlocked("Saved-search supplement has no complete rows")
    if any(str(row.get("INTERNAL ID", "")).strip() != internal_id for row in value["table_rows"]):
        raise RunnerBlocked("Saved-search supplement mixes exact IDs")
    # Read only after the exact coordination claim. Keep every column and
    # duplicate occurrence; these are dated CRM notes, not old model judgments.
    package["supplemental_company_context"] = value


def evidence_key(internal_id: str, package: dict[str, Any]) -> str:
    return hashlib.sha256(
        canonical_bytes(evidence_identity(internal_id, package))
    ).hexdigest()


def prepare_evidence_navigation(internal_id: str, package: dict[str, Any], *, agent_token: str = "", bypass: str = "") -> dict[str, Any]:
    """Install additive navigation only after the canonical claimed preflight.

    A matching completed legacy reader retains its original prompt/evidence
    identity so an interrupted record can reuse eligible reader/validator work.
    Accepted-publication recovery never invokes this helper.
    """
    identity = evidence_identity(internal_id, package)
    legacy = POOL_ROOT / "candidates" / f"{internal_id}.{evidence_key(internal_id, package)}.json"
    if reusable_artifact(legacy, identity, "reader", None) is not None:
        return {"status": "preserved_existing_model_artifacts", "private_requests_sent": 0}
    try:
        return navigation_bridge.prepare_package(
            internal_id, package, evidence=identity, root=POOL_ROOT / "navigation",
            dispatch=({"token": agent_token, "bypass": bypass}
                      if agent_token and os.environ.get("TAM_JEV_ANNOTATIONS_ENABLED", "true").lower() == "true" else None),
        )
    except (OSError, ValueError, KeyError, TypeError):
        # Navigation is an accelerator, never a new grading/publication gate.
        # Authoritative full evidence and existing validation still govern.
        package.pop("evidence_navigation", None)
        return {"status": "navigation_unavailable_full_evidence_retained", "private_requests_sent": 0}


def artifact_receipt_path(artifact_path: Path) -> Path:
    return artifact_path.with_name(artifact_path.name + ".receipt.json")


def receipt_matches(
    receipt: dict[str, Any],
    artifact_path: Path,
    identity: dict[str, Any],
    role: str,
    candidate_sha256: str | None,
) -> bool:
    if not artifact_path.is_file():
        return False
    expected = {
        "schema": "tam-full-evidence-model-artifact",
        "version": 1,
        "role": role,
        "evidence": identity,
        "artifactSha256": core.sha256_file(artifact_path),
        "candidateSha256": candidate_sha256,
        "completeRawEvidenceCoverage": True,
        "modelConcurrency": 1,
    }
    return all(receipt.get(key) == value for key, value in expected.items())


def write_artifact_receipt(
    artifact_path: Path,
    identity: dict[str, Any],
    role: str,
    candidate_sha256: str | None,
    mode: str,
) -> None:
    core.atomic_json(
        artifact_receipt_path(artifact_path),
        {
            "schema": "tam-full-evidence-model-artifact",
            "version": 1,
            "createdAt": core.utc_now(),
            "role": role,
            "evidence": identity,
            "artifactPath": str(artifact_path),
            "artifactSha256": core.sha256_file(artifact_path),
            "candidateSha256": candidate_sha256,
            "completeRawEvidenceCoverage": True,
            "modelConcurrency": 1,
            **({"modelConcurrencyScope": "one_exact_record", "maximumConcurrentRecordPipelines": 3}
               if PIPELINE_SLOT is not None else {}),
            "readMode": mode,
        },
    )


def reusable_artifact(
    artifact_path: Path,
    identity: dict[str, Any],
    role: str,
    candidate_sha256: str | None,
) -> dict[str, Any] | None:
    receipt_path = artifact_receipt_path(artifact_path)
    if not artifact_path.is_file() or not receipt_path.is_file():
        return None
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    if not receipt_matches(
        receipt, artifact_path, identity, role, candidate_sha256
    ):
        return None
    value = json.loads(artifact_path.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else None


def serial_chunk_reports(
    *,
    internal_id: str,
    role: str,
    package: dict[str, Any],
    logs: Path,
    codex_home: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    maximum_characters: int,
) -> list[dict[str, Any]]:
    """Losslessly cover oversized evidence with one model process at a time."""

    segments = core.chunk_segments(
        package, maximum_characters=maximum_characters
    )
    chunk_scope = role if ROUND_CONTEXT is None else f"{role}-{evidence_key(internal_id, package)[:16]}"
    chunk_root = POOL_ROOT / "oversized" / internal_id / chunk_scope
    chunk_root.mkdir(parents=True, exist_ok=True)
    if ROUND_CONTEXT is not None:
        scope_path = chunk_root / "evidence_identity.json"
        scope_identity = evidence_identity(internal_id, package)
        if scope_path.is_file():
            if json.loads(scope_path.read_bytes()) != scope_identity:
                raise RunnerBlocked("Chunk evidence or assessment context changed")
        else:
            core.atomic_json(scope_path, scope_identity)
    reports: list[dict[str, Any]] = []
    for segment in segments:
        output_path = chunk_root / f"chunk_{segment['index']:03d}.json"
        report: dict[str, Any] | None = None
        if output_path.is_file():
            candidate = json.loads(output_path.read_text(encoding="utf-8"))
            try:
                core.validate_chunk_report(
                    internal_id, role, segment, candidate
                )
                report = candidate
            except RuntimeError:
                report = None
        if report is None:
            report = core.run_codex(
                prompt=core.chunk_prompt(internal_id, role, segment),
                schema=core.CHUNK_SCHEMA,
                output_path=output_path,
                log_path=(
                    logs
                    / f"{internal_id}.single_{role}_chunk_"
                    f"{segment['index']:03d}.log"
                ),
                codex_home=codex_home,
                model=model,
                effort=effort,
                timeout_seconds=timeout_seconds,
            )
        core.validate_chunk_report(internal_id, role, segment, report)
        reports.append(report)
    return reports


def run_role(
    *,
    internal_id: str,
    role: str,
    package: dict[str, Any],
    candidate: dict[str, Any] | None,
    artifact_path: Path,
    logs: Path,
    codex_home: Path,
    model: str,
    effort: str,
    timeout_seconds: int,
    maximum_prompt_characters: int,
    chunk_characters: int,
) -> tuple[dict[str, Any], str]:
    if role == "reader":
        prompt = core.reader_prompt(internal_id, package)
        schema = core.READER_SCHEMA
    elif role == "validator" and candidate is not None:
        prompt = core.validator_prompt(internal_id, package, candidate)
        schema = core.VALIDATOR_SCHEMA
    else:
        raise ValueError("validator requires the exact reader candidate")

    if len(prompt) <= maximum_prompt_characters:
        value = core.run_codex(
            prompt=prompt,
            schema=schema,
            output_path=artifact_path,
            log_path=logs / f"{internal_id}.single_{role}.log",
            codex_home=codex_home,
            model=model,
            effort=effort,
            timeout_seconds=timeout_seconds,
        )
        return value, "direct-full-evidence"

    # Drop the large direct prompt before building lossless serial segments.
    del prompt
    reports = serial_chunk_reports(
        internal_id=internal_id,
        role=role,
        package=package,
        logs=logs,
        codex_home=codex_home,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
        maximum_characters=chunk_characters,
    )
    synthesis_prompt = core.chunk_synthesis_prompt(
        internal_id=internal_id,
        package=package,
        role=role,
        reports=reports,
        candidate=candidate,
    )
    value = core.run_codex(
        prompt=synthesis_prompt,
        schema=schema,
        output_path=artifact_path,
        log_path=logs / f"{internal_id}.single_{role}_synthesis.log",
        codex_home=codex_home,
        model=model,
        effort=effort,
        timeout_seconds=timeout_seconds,
    )
    return value, "serial-lossless-chunks"


def get_or_run_reader(
    internal_id: str,
    package: dict[str, Any],
    args: argparse.Namespace,
) -> tuple[dict[str, Any], Path, bool]:
    identity = evidence_identity(internal_id, package)
    key = evidence_key(internal_id, package)
    artifact_path = POOL_ROOT / "candidates" / f"{internal_id}.{key}.json"
    candidate = reusable_artifact(
        artifact_path, identity, "reader", None
    )
    if candidate is not None:
        if ROUND_CONTEXT is not None:
            candidate = core.with_display_contract(candidate, digest_field="chronological_digest")
        core.validate_candidate(
            internal_id,
            package,
            candidate,
            require_display_contract=False,
        )
        return candidate, artifact_path, True
    codex_home = record_codex_home()
    candidate, mode = run_role(
        internal_id=internal_id,
        role="reader",
        package=package,
        candidate=None,
        artifact_path=artifact_path,
        logs=role_logs(internal_id, package),
        codex_home=codex_home,
        model=args.reader_model,
        effort=args.reader_effort,
        timeout_seconds=args.timeout,
        maximum_prompt_characters=args.max_prompt_characters,
        chunk_characters=args.chunk_characters,
    )
    if ROUND_CONTEXT is not None:
        candidate = core.with_display_contract(candidate, digest_field="chronological_digest")
    core.validate_candidate(
        internal_id,
        package,
        candidate,
        require_display_contract=False,
    )
    write_artifact_receipt(artifact_path, identity, "reader", None, mode)
    return candidate, artifact_path, False


def validator_artifact_path(internal_id: str, evidence_sha256: str, candidate_sha256: str) -> Path:
    """Use one full digest for successor filenames, retaining both receipt pins.

    Concatenating two 64-character hashes exceeded Windows MAX_PATH once the
    model output temporary suffix was appended. The receipt still binds the
    complete evidence identity and candidate SHA independently.
    """
    if ROUND_CONTEXT is None:
        filename = f"{internal_id}.{evidence_sha256}.{candidate_sha256}.json"
    else:
        combined = hashlib.sha256(canonical_bytes({
            "evidenceSha256": evidence_sha256,
            "candidateSha256": candidate_sha256,
        })).hexdigest()
        filename = f"{internal_id}.{combined}.json"
    return POOL_ROOT / "validator_raw" / filename


def get_or_run_validator(
    internal_id: str,
    package: dict[str, Any],
    candidate: dict[str, Any],
    candidate_path: Path,
    args: argparse.Namespace,
) -> tuple[dict[str, Any], Path, bool]:
    identity = evidence_identity(internal_id, package)
    key = evidence_key(internal_id, package)
    candidate_sha256 = core.sha256_file(candidate_path)
    artifact_path = validator_artifact_path(internal_id, key, candidate_sha256)
    validation = reusable_artifact(
        artifact_path,
        identity,
        "validator",
        candidate_sha256,
    )
    if validation is not None:
        validation = core.with_display_contract(
            validation, digest_field="record_digest"
        )
        core.validate_final(internal_id, package, validation)
        return validation, artifact_path, True
    codex_home = record_codex_home()
    validation, mode = run_role(
        internal_id=internal_id,
        role="validator",
        package=package,
        candidate=candidate,
        artifact_path=artifact_path,
        logs=role_logs(internal_id, package),
        codex_home=codex_home,
        model=args.validator_model,
        effort=args.validator_effort,
        timeout_seconds=args.timeout,
        maximum_prompt_characters=args.max_prompt_characters,
        chunk_characters=args.chunk_characters,
    )
    validation = core.with_display_contract(
        validation, digest_field="record_digest"
    )
    core.validate_final(internal_id, package, validation)
    write_artifact_receipt(
        artifact_path,
        identity,
        "validator",
        candidate_sha256,
        mode,
    )
    return validation, artifact_path, False


def write_jsonl_atomic(path: Path, record: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(canonical_bytes(record) + b"\n")
    os.replace(temporary, path)


@contextmanager
def staging_read_lock():
    """Share the stager's short local lock so Windows readers cannot block replace."""
    FINAL_ROOT.mkdir(parents=True, exist_ok=True)
    lock = FINAL_ROOT / ".stage.lock"
    acquired = False
    for attempt in range(101):
        try:
            lock.mkdir()
            acquired = True
            break
        except FileExistsError:
            if attempt == 100:
                raise RunnerBlocked("timed out waiting for canonical staging read lock")
            time.sleep(0.1)
    try:
        yield
    finally:
        if acquired:
            lock.rmdir()


def find_jsonl_record(path: Path, field: str, expected: str) -> dict[str, Any] | None:
    if (PIPELINE_SLOT is not None and path.parent.resolve() == FINAL_ROOT.resolve()
            and path.name in {"publish_queue.jsonl", "final_assessments.jsonl"}):
        with staging_read_lock():
            return _find_jsonl_record(path, field, expected)
    return _find_jsonl_record(path, field, expected)


def _find_jsonl_record(
    path: Path,
    field: str,
    expected: str,
) -> dict[str, Any] | None:
    """Find one exact record without loading the aggregate stream into RAM."""

    if not path.is_file():
        return None
    found: dict[str, Any] | None = None
    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise RunnerBlocked(
                    f"{path}: JSONL line {line_number} is not an object"
                )
            if str(value.get(field) or "") != expected:
                continue
            if found is not None:
                raise RunnerBlocked(
                    f"{path}: duplicate exact record for {expected}"
                )
            found = value
    return found


def archive_superseded_hold(
    internal_id: str,
    *,
    pool_root: Path | None = None,
) -> dict[str, Any] | None:
    """Move a stale hold into immutable history after exact publish success."""

    pool_root = POOL_ROOT if pool_root is None else pool_root
    hold_path = pool_root / "holds" / f"{internal_id}.json"
    if not hold_path.is_file():
        return None
    hold_sha256 = core.sha256_file(hold_path)
    history_path = (
        pool_root
        / "holds"
        / "history"
        / f"{internal_id}.{hold_sha256}.superseded.json"
    )
    history_path.parent.mkdir(parents=True, exist_ok=True)
    if history_path.exists() and core.sha256_file(history_path) != hold_sha256:
        raise RunnerBlocked(
            f"superseded-hold history conflicts for {internal_id}"
        )
    os.replace(hold_path, history_path)
    return {
        "holdSha256": hold_sha256,
        "historyPath": str(history_path),
    }


def stage_one(validated_path: Path, internal_id: str) -> dict[str, Any]:
    command = [
        sys.executable,
        str(STAGER),
        "--validated",
        str(validated_path),
        "--output-dir",
        str(FINAL_ROOT),
        "--run-slug",
        RUN_SLUG,
        "--snapshot-sha256",
        core.SNAPSHOT_SHA256,
        "--actor-key",
        ACTOR_KEY,
        "--lock-attempts",
        "100" if PIPELINE_SLOT is not None else "1",
    ]
    if PIPELINE_SLOT is not None:
        command.extend(["--return-exact-payload", internal_id])
    result = subprocess.run(
        command,
        cwd=core.WORKSPACE,
        capture_output=True,
        text=True,
        timeout=300,
        creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        check=False,
    )
    if result.returncode:
        detail = (result.stdout or result.stderr)[-4000:]
        raise RunnerBlocked(f"canonical staging failed: {detail}")
    manifest = json.loads(result.stdout)
    if manifest.get("status") == "conflict":
        raise RunnerBlocked("canonical staging reported a final conflict")
    payload = manifest.get("exact_publish_payload") if PIPELINE_SLOT is not None else find_jsonl_record(
        FINAL_ROOT / "publish_queue.jsonl", "netsuiteInternalId", internal_id,
    )
    if not isinstance(payload, dict):
        raise RunnerBlocked("canonical staging produced no exact publish payload")
    if PIPELINE_SLOT is not None and (payload.get("netsuiteInternalId") != internal_id
                                     or payload.get("runSlug") != RUN_SLUG
                                     or payload.get("actorKey") != ACTOR_KEY):
        raise RunnerBlocked("canonical staging returned another exact record/actor")
    return payload


def prepare_publish_payload(
    payload: dict[str, Any],
    record: dict[str, Any],
    claim_token: str | None,
) -> dict[str, Any]:
    """Bind the transport to the raw-grade contract and exact lease."""

    prepared = dict(payload)
    prepared["codexScore"] = int(record["final_score"])
    provenance = dict(prepared.get("provenance") or {})
    provenance_data = provenance.get("data")
    if not isinstance(provenance_data, dict):
        raise RunnerBlocked("staged payload has no structured provenance")
    provenance["canonicalJson"] = canonical_bytes(provenance_data).decode("ascii")
    prepared["provenance"] = provenance
    if claim_token is not None:
        prepared["claimToken"] = claim_token
    else:
        prepared.pop("claimToken", None)
    return prepared


def verify_publish_payload(
    payload: dict[str, Any],
    record: dict[str, Any],
) -> None:
    if payload.get("runSlug") != RUN_SLUG:
        raise RunnerBlocked("staged payload run slug mismatch")
    if payload.get("netsuiteInternalId") != record["exact_id"]:
        raise RunnerBlocked("staged payload exact ID mismatch")
    if payload.get("actorKey") != ACTOR_KEY:
        raise RunnerBlocked("staged payload actor mismatch")
    if int(payload.get("finalScore", -1)) != int(record["final_score"]):
        raise RunnerBlocked("staged payload final score mismatch")
    if int(payload.get("codexScore", -1)) != int(record["final_score"]):
        raise RunnerBlocked("staged payload raw codex score mismatch")
    if payload.get("recordDigest") != record["record_digest"]:
        raise RunnerBlocked("staged payload digest mismatch")
    provenance = payload.get("provenance") or {}
    data = provenance.get("data") or {}
    canonical_json = provenance.get("canonicalJson")
    if not isinstance(canonical_json, str) or not canonical_json:
        raise RunnerBlocked("staged payload has no canonical provenance bytes")
    try:
        canonical_data = json.loads(canonical_json)
    except json.JSONDecodeError as exc:
        raise RunnerBlocked("staged payload canonical provenance is invalid JSON") from exc
    if canonical_data != data:
        raise RunnerBlocked("staged payload canonical provenance differs from data")
    if hashlib.sha256(canonical_json.encode("utf-8")).hexdigest() != provenance.get(
        "sha256"
    ):
        raise RunnerBlocked("staged payload provenance SHA-256 mismatch")
    if not str(provenance.get("objectPath") or "").strip():
        raise RunnerBlocked("staged payload provenance object path is missing")
    if data.get("schema") != "tam-grade-provenance" or data.get("version") != 1:
        raise RunnerBlocked("staged payload provenance schema mismatch")
    if data.get("snapshotSha256") != core.SNAPSHOT_SHA256:
        raise RunnerBlocked("staged payload snapshot hash mismatch")
    if data.get("candidateFileSha256") != record.get("candidate_file_sha256"):
        raise RunnerBlocked("staged payload reader-candidate hash mismatch")
    # The stager hashes the canonical validated record before it adds its
    # transport-only fields.  The in-memory validated record intentionally does
    # not contain that derived field yet, so reproduce the same canonical hash
    # instead of comparing against a missing key.
    validator_output_sha256 = hashlib.sha256(
        canonical_bytes(record)
    ).hexdigest()
    if data.get("validatorOutputSha256") != validator_output_sha256:
        raise RunnerBlocked("staged payload validator-output hash mismatch")
    if data.get("validatorHashScope") != "canonical-record":
        raise RunnerBlocked("staged payload validator hash scope mismatch")
    if data.get("pdfSha256") != record["pdf_sha256"]:
        raise RunnerBlocked("staged payload PDF hash mismatch")
    if data.get("recordTextSha256") != record["record_text_sha256"]:
        raise RunnerBlocked("staged payload record-text hash mismatch")
    if data.get("method") != (
        "full-record-reader-plus-independent-full-record-validator"
    ):
        raise RunnerBlocked("staged payload full-read method mismatch")
    validation = payload.get("validation") or {}
    if validation.get("status") != "passed":
        raise RunnerBlocked("staged payload is not independently validated")


def publish_once(
    secret: str,
    bypass: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    result = request_json_once(
        "POST", "/api/cron/tam-grade", secret, bypass, payload
    )
    if result.get("ok") is not True:
        raise RunnerBlocked(
            f"canonical TAM publish was not accepted: {result.get('error')}"
        )
    return result


def published_record_readback(
    secret: str,
    bypass: str,
    internal_id: str,
) -> dict[str, Any]:
    query = urllib.parse.urlencode(
        {
            "view": "records",
            "run": RUN_SLUG,
            "id": internal_id,
            "limit": "1",
        }
    )
    result = request_json_once(
        "GET",
        f"/api/cron/tam-coordination?{query}",
        secret,
        bypass,
    )
    records = result.get("records")
    if not isinstance(records, list) or len(records) != 1:
        raise RunnerBlocked("published exact-ID coordination readback is missing")
    record = records[0]
    if not isinstance(record, dict):
        raise RunnerBlocked("published coordination record is invalid")
    return record


def verify_published_readback(
    live: dict[str, Any],
    payload: dict[str, Any],
) -> None:
    provenance = payload.get("provenance") or {}
    validation = payload.get("validation") or {}
    expected = {
        "netsuite_internal_id": payload["netsuiteInternalId"],
        "grade_status": "published",
        "final_score": payload["finalScore"],
        "codex_score": payload["codexScore"],
        "record_digest": payload["recordDigest"],
        "grade_provenance_sha256": provenance.get("sha256"),
        "validation_status": "passed",
        "validated_by": validation.get("validatedBy"),
    }
    for field, value in expected.items():
        if live.get(field) != value:
            raise RunnerBlocked(f"published readback mismatch: {field}")


def verify_publish_event(
    secret: str,
    bypass: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    query = urllib.parse.urlencode({"run": RUN_SLUG, "events": "200"})
    status = request_json_once(
        "GET",
        f"/api/cron/tam-coordination?{query}",
        secret,
        bypass,
    )
    provenance_sha256 = (payload.get("provenance") or {}).get("sha256")
    events = status.get("events")
    if not isinstance(events, list):
        raise RunnerBlocked("coordination status returned no event stream")
    for event in events:
        if not isinstance(event, dict):
            continue
        metadata = event.get("metadata") or {}
        if (
            event.get("kind") == "grade.published"
            and str(event.get("netsuite_internal_id"))
            == payload["netsuiteInternalId"]
            and metadata.get("provenance_sha256") == provenance_sha256
        ):
            return event
    raise RunnerBlocked("exact grade.published event was not read back")


def local_preflight(internal_id: str) -> dict[str, Any]:
    if core.sha256_file(core.MEMBERSHIP) != core.MEMBERSHIP_SHA256:
        raise RunnerBlocked("canonical TAM membership SHA-256 drifted")
    current_ids = {
        str(row["Internal ID"]).strip() for row in core.membership_rows()
    }
    if internal_id not in current_ids:
        raise RunnerBlocked(
            f"NetSuite ID {internal_id} is not in canonical current membership"
        )
    for required in (
        core.CODEX_EXE,
        core.SSL_CERT_FILE,
        core.READER_SCHEMA,
        core.VALIDATOR_SCHEMA,
        core.CHUNK_SCHEMA,
        STAGER,
    ):
        if not required.is_file():
            raise RunnerBlocked(f"required TAM runner file is missing: {required}")
    package = core.trusted_package(internal_id)
    capture_snapshot = str(package["capture"].get("snapshot_sha256") or "")
    if ROUND_CONTEXT is None and capture_snapshot != core.SNAPSHOT_SHA256:
        require_reconciled_overlap_package(internal_id, package)
    return package


def self_check() -> dict[str, Any]:
    tam = load_control()
    checks = {
        "controlModeIsSingleRecord": tam.get("mode") == CONTROL_MODE,
        "maxConcurrentRecordsIsOne": tam.get("maxConcurrentRecords") == 1,
        "explicitlyEnabled": tam.get("enabled") is True,
        "membershipHashMatches": (
            core.MEMBERSHIP.is_file()
            and core.sha256_file(core.MEMBERSHIP) == core.MEMBERSHIP_SHA256
        ),
        "readerSchemaPresent": core.READER_SCHEMA.is_file(),
        "validatorSchemaPresent": core.VALIDATOR_SCHEMA.is_file(),
        "stagerPresent": STAGER.is_file(),
        "modelConcurrency": 1,
        "singleModelProcess": True,
        "queueDrain": False,
        "selfRelaunch": False,
        "browserRequired": False,
    }
    return {
        "status": "ready" if all(
            value is True
            for key, value in checks.items()
            if key not in {
                "explicitlyEnabled",
                "modelConcurrency",
                "queueDrain",
                "selfRelaunch",
                "browserRequired",
            }
        ) else "blocked",
        "checks": checks,
    }


def load_checkpoint() -> dict[str, Any]:
    if not CHECKPOINT_PATH.is_file():
        return {}
    value = json.loads(CHECKPOINT_PATH.read_text(encoding="utf-8"))
    return value if isinstance(value, dict) else {}


def heartbeat_once_noncritical(
    secret: str,
    bypass: str,
    internal_id: str,
    status: str,
    stage: str,
    claim_token: str | None = None,
) -> dict[str, Any]:
    try:
        heartbeat(
            secret,
            bypass,
            internal_id,
            status,
            stage,
            claim_token,
        )
        return {"confirmed": True}
    except Exception as error:
        return {
            "confirmed": False,
            "error": f"{type(error).__name__}: {error}",
        }


def validated_record(
    *,
    path: Path,
    internal_id: str,
    package: dict[str, Any],
    candidate: dict[str, Any],
    candidate_path: Path,
    validation: dict[str, Any],
) -> tuple[dict[str, Any], bool]:
    expected = core.final_record(
        internal_id=internal_id,
        package=package,
        candidate=candidate,
        candidate_path=candidate_path,
        validation=validation,
        validator_name="codex-single-record-independent-validator-v1",
    )
    if path.is_file():
        rows = core.json_lines(path)
        if len(rows) != 1:
            raise RunnerBlocked("hash-keyed validated artifact is not one record")
        existing = rows[0]
        existing_validation = existing.get("validation") or {}
        validated_at = existing_validation.get("validated_at")
        if not isinstance(validated_at, str) or not validated_at.strip():
            raise RunnerBlocked("validated artifact has no validation time")
        expected["validation"]["validated_at"] = validated_at
        # Confirmed staging revisions are deliberately appended after independent
        # validation.  They are transport provenance, not reader/validator
        # evidence, so their presence must not make a repeat publish of the same
        # exact validated artifact look like a conflicting regrade.
        comparable_existing = dict(existing)
        comparable_existing.pop("revision", None)
        comparable_existing.pop("revision_sequence", None)
        if comparable_existing != expected:
            raise RunnerBlocked("hash-keyed validated artifact conflicts")
        return existing, True
    write_jsonl_atomic(path, expected)
    return expected, False


def recover_accepted_publish(
    *,
    internal_id: str,
    package: dict[str, Any],
    previous: dict[str, Any],
    secret: str,
    bypass: str,
) -> dict[str, Any]:
    validated_path = Path(str(previous.get("validatedPath") or ""))
    if not validated_path.is_file():
        raise RunnerBlocked(
            "publish was accepted but its validated artifact is missing"
        )
    rows = core.json_lines(validated_path)
    if len(rows) != 1:
        raise RunnerBlocked(
            "publish was accepted but validated artifact is not one record"
        )
    record = rows[0]
    payload = find_jsonl_record(
        FINAL_ROOT / "publish_queue.jsonl",
        "netsuiteInternalId",
        internal_id,
    )
    if payload is None:
        raise RunnerBlocked(
            "publish was accepted but canonical publish payload is missing"
        )
    payload = prepare_publish_payload(
        payload,
        record,
        str(previous.get("claimToken") or "") or None,
    )
    verify_publish_payload(payload, record)
    payload_sha256 = hashlib.sha256(canonical_bytes(payload)).hexdigest()
    if payload_sha256 != previous.get("publishPayloadSha256"):
        raise RunnerBlocked(
            "publish was accepted but canonical payload SHA-256 changed"
        )
    live = published_record_readback(secret, bypass, internal_id)
    verify_published_readback(live, payload)
    event = verify_publish_event(secret, bypass, payload)
    published_path = POOL_ROOT / "published" / f"{internal_id}.json"
    core.atomic_json(
        published_path,
        {
            "publishedAt": core.utc_now(),
            "record": record,
            "payloadSha256": payload_sha256,
            "publish": previous.get("publishResponse"),
            "readback": live,
            "event": event,
            "recoveredReadback": True,
        },
    )
    archived_hold = archive_superseded_hold(internal_id)
    heartbeat_result = heartbeat_once_noncritical(
        secret, bypass, internal_id, "idle", "complete"
    )
    return checkpoint(
        internal_id,
        "complete",
        "published_readback_verified",
        evidence=evidence_identity(internal_id, package),
        finalScore=record["final_score"],
        validatedPath=str(validated_path),
        publishPayloadSha256=payload_sha256,
        publishedPath=str(published_path),
        archivedSupersededHold=archived_hold,
        recoveredReadback=True,
        heartbeat=heartbeat_result,
    )


def run_one(args: argparse.Namespace) -> dict[str, Any]:
    global ACTIVE_REVIEW
    internal_id = exact_internal_id(args.id)
    configure_record_execution(internal_id, getattr(args, "pipeline_slot", None))
    require_enabled(pipeline_slot=PIPELINE_SLOT)
    with record_execution_lock(internal_id):
        previous = load_checkpoint()
        require_recovery_slot(previous, internal_id)
        review = load_identity_review(getattr(args, "review_context", None), internal_id, args.include_hold, previous)
        ACTIVE_REVIEW = review["binding"].copy() if review else None
        if ACTIVE_REVIEW is not None:
            ACTIVE_REVIEW["reviewedFactsSha256"] = ACTIVE_REVIEW.pop("factsSha256")
            preserve_identity_review(review, previous)
        claim_token = (
            str(previous.get("claimToken"))
            if previous.get("exactId") == internal_id
            and previous.get("status") in {"working", "pending_action", "publish_accepted"}
            and isinstance(previous.get("claimToken"), str)
            else None
        )
        secret, bypass = read_api_secrets()
        if (
            previous.get("exactId") == internal_id
            and previous.get("status") == "publish_accepted"
            and previous.get("stage") == "readback"
        ):
            package = local_preflight(internal_id)
            attach_live_company_context(internal_id, package)
            attach_identity_review(package, internal_id, review)
            return recover_accepted_publish(
                internal_id=internal_id,
                package=package,
                previous=previous,
                secret=secret,
                bypass=bypass,
            )
        inherited_first_claim_preflight(review, secret, bypass)
        identity: dict[str, Any] = {"exactId": internal_id}
        claimed = False
        publish_accepted = False
        stage = "claim"
        timings = navigation_bridge.StageTimings(POOL_ROOT / "stage_timings", internal_id)
        try:
            try:
                actor_ack = heartbeat(secret, bypass, internal_id, "working", "claim")
                if not isinstance(actor_ack, dict):
                    raise RunnerBlocked("preclaim actor heartbeat acknowledgment missing")
                preclaim_run_id = preclaim_run_identity(actor_ack, internal_id)
                inherited_claim_transition(review, "claim_started")
                claimed_record = claim(
                    secret,
                    bypass,
                    internal_id,
                    include_hold=args.include_hold,
                    claim_token=claim_token,
                )
            except RunnerBlocked as error:
                stage = "coordination_required_unavailable"
                checkpoint(
                    internal_id,
                    "blocked",
                    stage,
                    evidence=identity,
                    coordinationAvailable=False,
                    blocker={
                        "kind": "coordination_required_unavailable",
                        "detail": str(error),
                    },
                )
                raise
            claimed = True
            claim_token = str(claimed_record["claim_token"])
            checkpoint(
                internal_id,
                "working",
                "claimed",
                evidence=identity,
                resumedClaim=bool(claimed_record.get("resumed")),
                reclaimedClaim=bool(claimed_record.get("reclaimed")),
                claimToken=claim_token,
                claimGeneration=claimed_record["claim_generation"],
                claimIdentity=claim_identity(claimed_record, internal_id, claim_token, preclaim_run_id),
            )
            inherited_claim_transition(review, "claimed")
            # A previous interrupted invocation may already have persisted a
            # durable local blocker.  If this actor resumes that same lease,
            # reconcile it to the coordination hold immediately; do not reopen
            # the reader or publish path unless --include-hold was explicit.
            preexisting_hold = POOL_ROOT / "holds" / f"{internal_id}.json"
            if preexisting_hold.is_file() and not args.include_hold:
                held = json.loads(preexisting_hold.read_text(encoding="utf-8"))
                reason = str(
                    held.get("reason")
                    or held.get("hold_reason")
                    or "preexisting durable local blocker"
                ).strip()
                set_grade_status_once(
                    secret,
                    bypass,
                    internal_id,
                    claim_token,
                    "hold",
                    reason,
                )
                heartbeat_result = heartbeat_once_noncritical(
                    secret, bypass, internal_id, "blocked", "hold", claim_token
                )
                return checkpoint(
                    internal_id,
                    "blocked",
                    "preexisting_local_hold",
                    evidence=identity,
                    blocker={"kind": "preexisting_local_hold", "reason": reason},
                    holdPath=str(preexisting_hold),
                    heartbeat=heartbeat_result,
                )
            stage = "local_evidence"
            timings.start("preparation")
            package = local_preflight(internal_id)
            attach_live_company_context(internal_id, package)
            attach_identity_review(package, internal_id, review)
            navigation_preparation = prepare_evidence_navigation(internal_id, package, agent_token=secret, bypass=bypass)
            timings.finish(reused=navigation_preparation.get("reused", False))
            identity = evidence_identity(internal_id, package)
            checkpoint(
                internal_id,
                "working",
                "local_evidence_verified",
                evidence=identity,
                claimToken=claim_token,
                navigationPreparation=navigation_preparation,
                stageTimingsPath=str(timings.path),
            )
            stage = "heartbeat_started"
            heartbeat(
                secret,
                bypass,
                internal_id,
                "working",
                "reader",
                claim_token,
            )

            stage = "reader"
            candidate, candidate_path, reader_reused = timings.call("reader", get_or_run_reader,
                internal_id, package, args
            )
            candidate_sha256 = core.sha256_file(candidate_path)
            checkpoint(
                internal_id,
                "working",
                "reader_complete",
                evidence=identity,
                candidatePath=str(candidate_path),
                candidateSha256=candidate_sha256,
                artifactReused=reader_reused,
            )

            stage = "heartbeat_started"
            heartbeat(
                secret,
                bypass,
                internal_id,
                "working",
                "validator",
                claim_token,
            )

            stage = "validator"
            validation, validation_path, validator_reused = (
                timings.call("validator", get_or_run_validator,
                    internal_id,
                    package,
                    candidate,
                    candidate_path,
                    args,
                )
            )
            validator_sha256 = core.sha256_file(validation_path)
            if validation["validation_status"] == "hold":
                record = core.final_record(
                    internal_id=internal_id,
                    package=package,
                    candidate=candidate,
                    candidate_path=candidate_path,
                    validation=validation,
                    validator_name=(
                        "codex-single-record-independent-validator-v1"
                    ),
                )
                hold_path = POOL_ROOT / "holds" / f"{internal_id}.json"
                core.atomic_json(hold_path, record)
                reason = str(validation["hold_reason"]).strip()
                set_grade_status_once(
                    secret,
                    bypass,
                    internal_id,
                    claim_token,
                    "hold",
                    reason,
                )
                heartbeat_result = heartbeat_once_noncritical(
                    secret, bypass, internal_id, "blocked", "hold"
                )
                return checkpoint(
                    internal_id,
                    "blocked",
                    "validator_hold",
                    evidence=identity,
                    blocker={"kind": "validator_hold", "reason": reason},
                    candidatePath=str(candidate_path),
                    candidateSha256=candidate_sha256,
                    validatorPath=str(validation_path),
                    validatorSha256=validator_sha256,
                    artifactReused={
                        "reader": reader_reused,
                        "validator": validator_reused,
                    },
                    holdPath=str(hold_path),
                    heartbeat=heartbeat_result,
                )

            stage = "canonical_staging"
            timings.start("staging")
            validation_key = hashlib.sha256(
                canonical_bytes(
                    {
                        "evidence": identity,
                        "candidateSha256": candidate_sha256,
                        "validatorSha256": validator_sha256,
                    }
                )
            ).hexdigest()
            validated_path = (
                POOL_ROOT
                / "validated"
                / f"{internal_id}.{validation_key}.jsonl"
            )
            record, validated_reused = validated_record(
                path=validated_path,
                internal_id=internal_id,
                package=package,
                candidate=candidate,
                candidate_path=candidate_path,
                validation=validation,
            )
            existing = find_jsonl_record(
                FINAL_ROOT / "final_assessments.jsonl", "exact_id", internal_id
            )
            same_confirmed_revision = (
                existing is not None
                and int(record.get("revision_sequence", 0))
                == int(existing.get("revision_sequence", 0))
                and record.get("candidate_file_sha256")
                == existing.get("candidate_file_sha256")
                and record.get("validator_output_sha256")
                == existing.get("validator_output_sha256")
            )
            if existing is not None and not same_confirmed_revision:
                prior_hash = hashlib.sha256(canonical_bytes(existing)).hexdigest()
                record["revision_sequence"] = int(existing.get("revision_sequence", 0)) + 1
                record["revision"] = {
                    "status": "confirmed",
                    "prior_final_sha256": prior_hash,
                    "third_pass_audit_sha256": candidate_sha256,
                    "adjudication_sha256": validator_sha256,
                }
                write_jsonl_atomic(validated_path, record)
            payload = prepare_publish_payload(
                stage_one(validated_path, internal_id),
                record,
                claim_token,
            )
            verify_publish_payload(payload, record)
            timings.finish(reused=validated_reused)
            payload_sha256 = hashlib.sha256(canonical_bytes(payload)).hexdigest()
            checkpoint(
                internal_id,
                "pending_action",
                "publish",
                evidence=identity,
                candidatePath=str(candidate_path),
                candidateSha256=candidate_sha256,
                validatorPath=str(validation_path),
                validatorSha256=validator_sha256,
                validatedPath=str(validated_path),
                validatedArtifactReused=validated_reused,
                publishPayloadSha256=payload_sha256,
                publishRequestStarted=False,
            )

            stage = "heartbeat_started"
            if claim_token is None:
                raise RunnerBlocked("coordination publish has no fencing token")
            heartbeat(
                secret,
                bypass,
                internal_id,
                "working",
                "publish",
                claim_token,
            )
            stage = "publish"
            timings.start("publication")
            coordination_checkpoint(internal_id, coordinationPhase="publish_started", publishRequestStarted=True)
            publish_result = publish_once(secret, bypass, payload)
            publish_accepted = True
            checkpoint(
                internal_id,
                "publish_accepted",
                "readback",
                evidence=identity,
                validatedPath=str(validated_path),
                publishPayloadSha256=payload_sha256,
                publishResponse=publish_result,
            )

            stage = "readback"
            live = published_record_readback(
                secret, bypass, internal_id
            )
            verify_published_readback(live, payload)
            event = verify_publish_event(secret, bypass, payload)
            timings.finish()
            published_path = POOL_ROOT / "published" / f"{internal_id}.json"
            core.atomic_json(
                published_path,
                {
                    "publishedAt": core.utc_now(),
                    "record": record,
                    "payloadSha256": payload_sha256,
                    "publish": publish_result,
                    "readback": live,
                    "event": event,
                },
            )
            archived_hold = archive_superseded_hold(internal_id)
            heartbeat_result = heartbeat_once_noncritical(
                secret, bypass, internal_id, "idle", "complete"
            )
            # Publication/readback are already complete. This separate local
            # research artifact sends only the exact ID, never CRM evidence,
            # and cannot change or delay the grade's publication.
            context_comparison = public_context.refresh_comparison(
                internal_id, validation, validator_sha256=validator_sha256,
                root=POOL_ROOT / "public_context", token=secret, bypass=bypass,
            )
            return checkpoint(
                internal_id,
                "complete",
                "published_readback_verified",
                evidence=identity,
                navigationPreparation=navigation_preparation,
                stageTimingsPath=str(timings.path),
                publicContextComparison=context_comparison,
                finalScore=record["final_score"],
                candidatePath=str(candidate_path),
                candidateSha256=candidate_sha256,
                validatorPath=str(validation_path),
                validatorSha256=validator_sha256,
                validatedPath=str(validated_path),
                publishPayloadSha256=payload_sha256,
                publishedPath=str(published_path),
                archivedSupersededHold=archived_hold,
                artifactReused={
                    "reader": reader_reused,
                    "validator": validator_reused,
                    "validated": validated_reused,
                },
                heartbeat=heartbeat_result,
            )
        except Exception as error:
            timings.finish("failed")
            if stage == "coordination_required_unavailable":
                raise RunnerBlocked(str(error)) from error
            detail = f"{type(error).__name__}: {error}"
            if publish_accepted:
                # An acknowledged publication must remain on the readback-only
                # recovery path, including when its first checkpoint write failed.
                checkpoint(
                    internal_id,
                    "publish_accepted",
                    "readback",
                    evidence=identity,
                    validatedPath=str(validated_path),
                    publishPayloadSha256=payload_sha256,
                    publishResponse=publish_result,
                    publishAccepted=True,
                    blocker={"kind": "accepted_publication_readback_failed",
                             "stage": stage, "detail": detail},
                )
                raise RunnerBlocked(
                    "Publication was accepted; exact readback recovery is required."
                ) from error
            # Any reader/validator/staging failure before an accepted publish is
            # not safe to retry implicitly: its exact ID must leave the canonical
            # queue until a human can resolve the evidence defect. Persist a
            # minimal, selector-compatible hold even when the normal validator
            # result was never produced.
            hold_path: Path | None = None
            if (
                stage in {"reader", "validator", "canonical_staging", "publish", "heartbeat_started"}
                and not publish_accepted
            ):
                try:
                    hold_path = POOL_ROOT / "holds" / f"{internal_id}.json"
                    core.atomic_json(
                        hold_path,
                        {
                            "schema": "tam-single-record-exception-hold",
                            "version": 1,
                            "exactId": internal_id,
                            "stage": stage,
                            "reason": detail,
                            "evidence": identity,
                        },
                    )
                except Exception as hold_error:
                    detail = (
                        f"{detail}; hold persistence failed: "
                        f"{type(hold_error).__name__}: {hold_error}"
                    )
            release: dict[str, Any] | None = None
            if claimed and not publish_accepted:
                try:
                    if stage in {
                        "reader",
                        "validator",
                        "canonical_staging",
                        "publish",
                        "heartbeat_started",
                    }:
                        release = set_grade_status_once(
                            secret,
                            bypass,
                            internal_id,
                            claim_token,
                            "hold",
                            (f"Coordination heartbeat blocked before publication: {detail}" if stage == "heartbeat_started"
                             else f"Validated locally; {stage} blocked: {detail}"),
                        )
                    else:
                        release = set_grade_status_once(
                            secret,
                            bypass,
                            internal_id,
                            claim_token,
                            "pending",
                        )
                except Exception as release_error:
                    release = {
                        "unconfirmed": True,
                        "error": (
                            f"{type(release_error).__name__}: {release_error}"
                        ),
                    }
            result = checkpoint(
                internal_id,
                "blocked",
                stage,
                evidence=identity,
                blocker={"kind": "heartbeat_coordination_failed" if stage == "heartbeat_started"
                         else "single_attempt_failed", "detail": detail},
                holdPath=str(hold_path) if hold_path else None,
                coordinationRelease=release,
                publishAccepted=publish_accepted,
                retryAttempted=isinstance(load_checkpoint().get("heartbeatRecovery"), dict)
                    and load_checkpoint()["heartbeatRecovery"].get("claimIdentity") == load_checkpoint().get("claimIdentity")
                    and load_checkpoint()["heartbeatRecovery"].get("recoveryPostsStarted") == 1,
            )
            raise RunnerBlocked(json.dumps(result, ensure_ascii=True)) from error


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Claim and process exactly one TAM Internal ID, then exit."
        )
    )
    parser.add_argument("--id", help="one exact numeric NetSuite Internal ID")
    parser.add_argument("--round-context", type=Path,
                        help="canonical successor context; defaults to the mission's active round")
    parser.add_argument("--review-context", type=Path,
                        help="independently approved exact-ID attribution facts; requires --include-hold")
    parser.add_argument("--pipeline-slot", type=int, choices=(1, 2, 3),
                        help="explicitly authorized concurrent exact-ID pipeline slot; default remains serial")
    parser.add_argument(
        "--include-hold",
        action="store_true",
        help="explicitly reopen this exact held record",
    )
    parser.add_argument(
        "--model",
        choices=["gpt-5.6-sol", "gpt-5.6-terra"],
        default=None,
        help="explicit compatibility override that sets both role models",
    )
    parser.add_argument(
        "--reader-model",
        choices=["gpt-5.6-sol", "gpt-5.6-terra"],
        default="gpt-5.6-terra",
    )
    parser.add_argument(
        "--validator-model",
        choices=["gpt-5.6-sol", "gpt-5.6-terra"],
        default="gpt-5.6-sol",
        help="production final validator remains the frontier sol model",
    )
    parser.add_argument(
        "--effort",
        choices=["medium", "high", "xhigh", "max", "ultra"],
        default=None,
        help="explicit compatibility override that sets both role efforts",
    )
    parser.add_argument(
        "--reader-effort",
        choices=["medium", "high", "xhigh", "max", "ultra"],
        default="medium",
    )
    parser.add_argument(
        "--validator-effort",
        choices=["medium", "high", "xhigh", "max", "ultra"],
        default="high",
    )
    parser.add_argument("--timeout", type=int, default=1800)
    parser.add_argument(
        "--max-prompt-characters", type=int, default=900_000
    )
    parser.add_argument("--chunk-characters", type=int, default=250_000)
    parser.add_argument(
        "--self-check",
        action="store_true",
        help="inspect local guards only; never claim, call a model, or publish",
    )
    args = parser.parse_args(argv)
    if args.review_context is not None and (not args.include_hold or args.self_check):
        parser.error("--review-context requires --include-hold and one exact record")
    if args.model is not None:
        args.reader_model = args.model
        args.validator_model = args.model
    if args.effort is not None:
        args.reader_effort = args.effort
        args.validator_effort = args.effort
    if not args.self_check and not args.id:
        parser.error("--id is required unless --self-check is used")
    if args.id:
        try:
            args.id = exact_internal_id(args.id)
        except ValueError as error:
            parser.error(str(error))
    if not 60 <= args.timeout <= 3600:
        parser.error("--timeout must be 60-3600 seconds")
    # Permit the lossless segmented fallback for medium-sized records too.  A
    # direct prompt can be rejected by the model gateway even well below the
    # previous 100k floor; segments are already bounded to 50k below.
    if not 50_000 <= args.max_prompt_characters <= 900_000:
        parser.error("--max-prompt-characters must be 50000-900000")
    if not 50_000 <= args.chunk_characters <= 300_000:
        parser.error("--chunk-characters must be 50000-300000")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        configure_canonical_round(args.round_context, require_ready=not args.self_check)
    except RunnerBlocked as error:
        print(json.dumps({"status": "blocked", "error": str(error)}), file=sys.stderr)
        return 2
    if args.self_check:
        print(json.dumps(self_check(), indent=2, sort_keys=True))
        return 0
    try:
        result = run_one(args)
    except RunnerBlocked as error:
        print(
            json.dumps(
                {"status": "blocked", "error": str(error)},
                indent=2,
                sort_keys=True,
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
