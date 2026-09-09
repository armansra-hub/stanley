#!/usr/bin/env python3
"""Bounded read-only queries for the newest canonical MMTT batch."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path
from typing import Any


WORKSPACE = Path(r"C:\Users\Arman Sra\Documents\Stanley")
MAX_OUTPUT_BYTES = 64_000
TERMINAL_TOUCH = {"completed", "completed_by_user", "skipped"}


def newest_batch() -> Path:
    candidates = sorted(WORKSPACE.glob("mmtt-event-cadence-batch-*.json"))
    if not candidates:
        raise RuntimeError("No canonical MMTT batch exists")
    return max(candidates, key=lambda path: (path.stat().st_mtime_ns, path.name))


def read_batch(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(value, dict) or not isinstance(value.get("items"), list):
        raise RuntimeError("MMTT batch must be an object containing items[]")
    keys = [
        str(row.get("idempotency_key"))
        for row in value["items"]
        if isinstance(row, dict)
    ]
    if len(keys) != len(set(keys)):
        raise RuntimeError("MMTT batch contains duplicate idempotency keys")
    return value


def compact_item(row: dict[str, Any]) -> dict[str, Any]:
    return {
        key: row.get(key)
        for key in (
            "idempotency_key",
            "full_name",
            "company",
            "email",
            "event",
            "status",
            "initial_sent_message_id",
            "initial_sent_at",
            "cadence_status",
            "crm_touch_status",
            "next_eligible_send_at",
        )
        if key in row
    }


def snapshot(
    batch: dict[str, Any], path: Path, limit: int, after_key: str | None
) -> dict[str, Any]:
    items = [row for row in batch["items"] if isinstance(row, dict)]
    pending = [
        compact_item(row)
        for row in items
        if str(row.get("crm_touch_status", "")) not in TERMINAL_TOUCH
    ]
    pending.sort(key=lambda row: str(row.get("idempotency_key", "")))
    start = 0
    if after_key:
        matches = [
            index
            for index, row in enumerate(pending)
            if str(row.get("idempotency_key")) == after_key
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"Expected one MMTT cursor {after_key!r}; found {len(matches)}"
            )
        start = matches[0] + 1
    page = pending[start : start + limit]
    more = start + len(page) < len(pending)
    return {
        "schema": "mmtt-run-snapshot",
        "version": 1,
        "source": {"path": str(path), "bytes": path.stat().st_size},
        "batch_id": batch.get("batch_id"),
        "approval": batch.get("approval"),
        "batch_status": batch.get("batch_status"),
        "counts": {
            "items": len(items),
            "status": dict(Counter(str(row.get("status", "")) for row in items)),
            "cadence_status": dict(
                Counter(str(row.get("cadence_status", "")) for row in items)
            ),
            "crm_touch_status": dict(
                Counter(str(row.get("crm_touch_status", "")) for row in items)
            ),
            "pending_items": len(pending),
        },
        "pending_items": page,
        "paging": {
            "limit": limit,
            "more": more,
            "next_after": (
                str(page[-1].get("idempotency_key")) if page and more else None
            ),
        },
    }


def emit(value: Any) -> None:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    if len(encoded) > MAX_OUTPUT_BYTES:
        raise RuntimeError(
            f"Refusing {len(encoded)}-byte MMTT output; narrow below "
            f"{MAX_OUTPUT_BYTES} bytes"
        )
    print(encoded.decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=Path)
    subparsers = parser.add_subparsers(dest="command", required=True)
    snapshot_parser = subparsers.add_parser("snapshot")
    snapshot_parser.add_argument("--limit", type=int, default=10)
    snapshot_parser.add_argument("--after-key")
    item_parser = subparsers.add_parser("item")
    item_parser.add_argument("--idempotency-key", required=True)
    args = parser.parse_args()

    path = args.batch.resolve() if args.batch else newest_batch()
    batch = read_batch(path)
    if args.command == "snapshot":
        if not 1 <= args.limit <= 25:
            raise RuntimeError("snapshot --limit must be between 1 and 25")
        emit(snapshot(batch, path, args.limit, args.after_key))
        return 0
    matches = [
        row
        for row in batch["items"]
        if isinstance(row, dict)
        and str(row.get("idempotency_key")) == args.idempotency_key
    ]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one MMTT item {args.idempotency_key!r}; found {len(matches)}"
        )
    emit(matches[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
