#!/usr/bin/env python3
"""Bounded, read-only queries for the canonical Outlook cadence ledger."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_STATE = Path(
    r"C:\Users\Arman Sra\Documents\Sales hub\outlook_cadence_state.json"
)
MAX_OUTPUT_BYTES = 256_000
TERMINAL_CADENCE_STATUSES = {"completed", "permanently_stopped"}


def read_state(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict):
        raise ValueError("Outlook cadence state must be a JSON object")
    if not isinstance(value.get("cadences"), list):
        raise ValueError("Outlook cadence state is missing cadences[]")
    if not isinstance(value.get("crm_touch_retry_queue"), list):
        raise ValueError("Outlook cadence state is missing crm_touch_retry_queue[]")
    for row in value["cadences"]:
        if not isinstance(row, dict):
            continue
        is_mmtt = row.get("cadence_type") == "mmtt_event" or str(row.get("id", "")).startswith("mmtt-")
        if not is_mmtt:
            continue
        step = row.get("next_step")
        if row.get("status") in {"active", "scheduled_pending_delivery"} and isinstance(step, int) and step > 2:
            raise ValueError(f"MMTT cadence exceeds the two-follow-up cap: {row.get('id')}")
        action = row.get("scheduled_action")
        if isinstance(action, dict) and action.get("status") == "scheduled_pending_delivery" and int(action.get("step", 0)) > 2:
            raise ValueError(f"MMTT scheduled action exceeds the two-follow-up cap: {row.get('id')}")
    return value


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def compact_cadence(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "id",
            "cadence_type",
            "max_followups",
            "enrollment_source",
            "prospect",
            "thread",
            "next_step",
            "next_eligible_send_at",
            "sent_steps",
            "last_response_check_at",
            "status",
            "scheduled_action",
            "completion",
            "automatic_reply_pause",
            "permanent_stop",
            "custom_followup",
            "response_override",
        )
        if key in row
    }


def compact_retry(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "idempotency_key",
            "cadence_id",
            "step",
            "recipient_email",
            "expected_subject",
            "touch_type",
            "status",
            "company_id",
            "contact_id",
            "created_at",
            "last_attempt_at",
            "last_error",
        )
        if key in row
    }


def page_after(
    rows: list[dict[str, Any]],
    key: str,
    after: str | None,
    limit: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    start = 0
    if after:
        matches = [index for index, row in enumerate(rows) if str(row.get(key)) == after]
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected one {key} cursor {after!r}; found {len(matches)}"
            )
        start = matches[0] + 1
    selected = rows[start : start + limit]
    more = start + len(selected) < len(rows)
    return selected, {
        "limit": limit,
        "more": more,
        "next_after": str(selected[-1].get(key)) if selected and more else None,
    }


def snapshot(
    state: dict[str, Any],
    now: datetime,
    limit: int,
    after_cadence_id: str | None,
    after_retry_key: str | None,
) -> dict[str, Any]:
    cadences = [row for row in state["cadences"] if isinstance(row, dict)]
    active = [
        row
        for row in cadences
        if str(row.get("status", "")) not in TERMINAL_CADENCE_STATUSES
    ]
    due: list[dict[str, Any]] = []
    for row in active:
        eligible = parse_time(row.get("next_eligible_send_at"))
        if row.get("status") == "active" and eligible is not None and eligible <= now:
            due.append(compact_cadence(row))
    due.sort(key=lambda row: (str(row.get("next_eligible_send_at", "")), str(row.get("id", ""))))

    pending_retries = [
        compact_retry(row)
        for row in state["crm_touch_retry_queue"]
        if isinstance(row, dict) and row.get("status") == "pending"
    ]
    pending_retries.sort(key=lambda row: (str(row.get("created_at", "")), str(row.get("idempotency_key", ""))))

    due_page, due_paging = page_after(
        due, "id", after_cadence_id, limit
    )
    retry_page, retry_paging = page_after(
        pending_retries, "idempotency_key", after_retry_key, limit
    )

    return {
        "schema": "outlook-cadence-run-snapshot",
        "version": 1,
        "generated_at": now.isoformat().replace("+00:00", "Z"),
        "source_updated_at": state.get("updated_at"),
        "counts": {
            "cadences_total": len(cadences),
            "cadences_active_or_paused": len(active),
            "cadences_due": len(due),
            "touch_retries_pending": len(pending_retries),
        },
        "pending_action": state.get("pending_action"),
        "due_cadences": due_page,
        "pending_touch_retries": retry_page,
        "paging": {
            "due_cadences": due_paging,
            "pending_touch_retries": retry_paging,
        },
        "domain_pauses": state.get("domain_pauses", []),
        "company_do_not_contact": state.get("company_do_not_contact", []),
        "daily_initial_audit": state.get("daily_initial_audit", {}),
    }


def emit(value: Any) -> None:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise RuntimeError(
            f"Refusing {len(encoded)}-byte output; narrow the query below {MAX_OUTPUT_BYTES} bytes"
        )
    print(encoded.decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--limit", type=int, default=10)
    snapshot_parser.add_argument("--after-cadence-id")
    snapshot_parser.add_argument("--after-retry-key")
    cadence_parser = subparsers.add_parser("cadence")
    cadence_parser.add_argument("--id", required=True)
    contact_parser = subparsers.add_parser("contact")
    contact_parser.add_argument("--email", required=True)
    domain_parser = subparsers.add_parser("domain")
    domain_parser.add_argument("--domain", required=True)
    retry_parser = subparsers.add_parser("retry")
    retry_parser.add_argument("--idempotency-key", required=True)
    args = parser.parse_args()

    state = read_state(args.state.resolve())
    if args.command == "snapshot":
        if not 1 <= args.limit <= 25:
            raise RuntimeError("snapshot --limit must be between 1 and 25")
        emit(
            snapshot(
                state,
                datetime.now(timezone.utc),
                args.limit,
                args.after_cadence_id,
                args.after_retry_key,
            )
        )
        return 0
    if args.command == "cadence":
        matches = [
            row
            for row in state["cadences"]
            if isinstance(row, dict) and str(row.get("id")) == args.id
        ]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one cadence {args.id!r}; found {len(matches)}")
        emit(matches[0])
        return 0
    if args.command == "contact":
        email = args.email.strip().lower()
        matches = [
            compact_cadence(row)
            for row in state["cadences"]
            if isinstance(row, dict)
            and str((row.get("prospect") or {}).get("email", "")).strip().lower() == email
        ]
        suppressions = [
            row
            for row in state.get("contact_do_not_contact", [])
            if isinstance(row, dict) and str(row.get("email", "")).strip().lower() == email
        ]
        emit({"email": email, "cadences": matches, "contact_do_not_contact": suppressions})
        return 0
    if args.command == "domain":
        domain = args.domain.strip().lower()
        matches = []
        for row in state["cadences"]:
            if not isinstance(row, dict):
                continue
            prospect = row.get("prospect") or {}
            aliases = {
                str(prospect.get("domain") or "").strip().lower(),
                str(prospect.get("company_domain") or "").strip().lower(),
                *[str(value).strip().lower() for value in prospect.get("domain_aliases") or []],
            }
            if domain in aliases:
                matches.append(compact_cadence(row))
        pauses = [
            row for row in state.get("domain_pauses", [])
            if isinstance(row, dict) and str(row.get("domain", "")).strip().lower() == domain
        ]
        emit({"domain": domain, "cadences": matches, "domain_pauses": pauses})
        return 0
    matches = [
        row
        for row in state["crm_touch_retry_queue"]
        if isinstance(row, dict)
        and str(row.get("idempotency_key")) == args.idempotency_key
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one retry {args.idempotency_key!r}; found {len(matches)}"
        )
    emit(matches[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
