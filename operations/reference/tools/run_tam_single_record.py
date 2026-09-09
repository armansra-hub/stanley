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
import urllib.error
import urllib.parse
import urllib.request
from contextlib import AbstractContextManager
from pathlib import Path
from typing import Any, BinaryIO, Callable

try:
    from tools import tam_record_core as core
except ModuleNotFoundError:  # Direct execution: python tools/<this-file>.py
    import tam_record_core as core


RUN_SLUG = "ars-bs-tam-current"
ACTOR_KEY = "codex-single-record-v1"
CONTROL_MODE = "checkpointed-single-record"
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


class RunnerBlocked(RuntimeError):
    """A fail-closed, persisted blocker rather than a retry instruction."""


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


def require_enabled(path: Path = core.AUTOMATION_CONTROL) -> dict[str, Any]:
    tam = load_control(path)
    if tam.get("enabled") is not True:
        raise RunnerBlocked("TAM regrade is disabled in automation-control.json")
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
    value = {
        "schema": "tam-checkpointed-single-record",
        "version": 1,
        "runSlug": RUN_SLUG,
        "actorKey": ACTOR_KEY,
        "exactId": internal_id,
        "status": status,
        "stage": stage,
        "updatedAt": core.utc_now(),
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


def heartbeat(
    secret: str,
    bypass: str,
    internal_id: str,
    status: str,
    stage: str,
    claim_token: str | None = None,
) -> None:
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
        },
    }
    if claim_token is not None:
        action.update({
            "netsuiteInternalId": internal_id,
            "claimToken": claim_token,
            "leaseSeconds": CLAIM_LEASE_SECONDS,
        })
    coordination_post(
        secret,
        bypass,
        action,
    )


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
    return identity


def attach_live_company_context(
    internal_id: str,
    package: dict[str, Any],
) -> None:
    """The verified PDF/record package is the complete evidence source.

    The seeded lifecycle permits only coordination and tam-grade traffic.  Do
    not call the retired agent-read bridge to decorate evidence with mutable
    company fields.
    """
    _ = internal_id, package


def evidence_key(internal_id: str, package: dict[str, Any]) -> str:
    return hashlib.sha256(
        canonical_bytes(evidence_identity(internal_id, package))
    ).hexdigest()


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
    chunk_root = POOL_ROOT / "oversized" / internal_id / role
    chunk_root.mkdir(parents=True, exist_ok=True)
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
        core.validate_candidate(
            internal_id,
            package,
            candidate,
            require_display_contract=False,
        )
        return candidate, artifact_path, True
    codex_home = core.prepare_codex_home()
    candidate, mode = run_role(
        internal_id=internal_id,
        role="reader",
        package=package,
        candidate=None,
        artifact_path=artifact_path,
        logs=POOL_ROOT / "logs",
        codex_home=codex_home,
        model=args.reader_model,
        effort=args.reader_effort,
        timeout_seconds=args.timeout,
        maximum_prompt_characters=args.max_prompt_characters,
        chunk_characters=args.chunk_characters,
    )
    core.validate_candidate(
        internal_id,
        package,
        candidate,
        require_display_contract=False,
    )
    write_artifact_receipt(artifact_path, identity, "reader", None, mode)
    return candidate, artifact_path, False


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
    artifact_path = (
        POOL_ROOT
        / "validator_raw"
        / f"{internal_id}.{key}.{candidate_sha256}.json"
    )
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
    codex_home = core.prepare_codex_home()
    validation, mode = run_role(
        internal_id=internal_id,
        role="validator",
        package=package,
        candidate=candidate,
        artifact_path=artifact_path,
        logs=POOL_ROOT / "logs",
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


def find_jsonl_record(
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
    pool_root: Path = POOL_ROOT,
) -> dict[str, Any] | None:
    """Move a stale hold into immutable history after exact publish success."""

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
        "1",
    ]
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
    payload = find_jsonl_record(
        FINAL_ROOT / "publish_queue.jsonl",
        "netsuiteInternalId",
        internal_id,
    )
    if not isinstance(payload, dict):
        raise RunnerBlocked("canonical staging produced no exact publish payload")
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
    if capture_snapshot != core.SNAPSHOT_SHA256:
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
    internal_id = exact_internal_id(args.id)
    require_enabled()
    with SingleRunnerLock():
        previous = load_checkpoint()
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
            return recover_accepted_publish(
                internal_id=internal_id,
                package=package,
                previous=previous,
                secret=secret,
                bypass=bypass,
            )
        identity: dict[str, Any] = {"exactId": internal_id}
        claimed = False
        publish_accepted = False
        stage = "claim"
        try:
            try:
                heartbeat(secret, bypass, internal_id, "working", "claim")
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
            )
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
            package = local_preflight(internal_id)
            attach_live_company_context(internal_id, package)
            identity = evidence_identity(internal_id, package)
            checkpoint(
                internal_id,
                "working",
                "local_evidence_verified",
                evidence=identity,
                claimToken=claim_token,
            )
            heartbeat(
                secret,
                bypass,
                internal_id,
                "working",
                "reader",
                claim_token,
            )

            stage = "reader"
            candidate, candidate_path, reader_reused = get_or_run_reader(
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
                get_or_run_validator(
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
            )

            stage = "publish"
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
            return checkpoint(
                internal_id,
                "complete",
                "published_readback_verified",
                evidence=identity,
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
            if stage == "coordination_required_unavailable":
                raise RunnerBlocked(str(error)) from error
            detail = f"{type(error).__name__}: {error}"
            # Any reader/validator/staging failure before an accepted publish is
            # not safe to retry implicitly: its exact ID must leave the canonical
            # queue until a human can resolve the evidence defect. Persist a
            # minimal, selector-compatible hold even when the normal validator
            # result was never produced.
            hold_path: Path | None = None
            if (
                stage in {"reader", "validator", "canonical_staging", "publish"}
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
                    }:
                        release = set_grade_status_once(
                            secret,
                            bypass,
                            internal_id,
                            claim_token,
                            "hold",
                            f"Validated locally; {stage} blocked: {detail}",
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
                blocker={"kind": "single_attempt_failed", "detail": detail},
                holdPath=str(hold_path) if hold_path else None,
                coordinationRelease=release,
                publishAccepted=publish_accepted,
                retryAttempted=False,
            )
            raise RunnerBlocked(json.dumps(result, ensure_ascii=True)) from error


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Claim and process exactly one TAM Internal ID, then exit."
        )
    )
    parser.add_argument("--id", help="one exact numeric NetSuite Internal ID")
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
