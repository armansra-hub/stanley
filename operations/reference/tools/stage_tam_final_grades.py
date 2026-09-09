#!/usr/bin/env python3
"""Stage passed TAM finals with deterministic provenance and conflict checks."""

from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    records = []
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}: line {line_number} is not an object")
        records.append(value)
    return records


def write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_bytes(data)
    os.replace(temp, path)


def acquire_stage_lock(output_dir: Path, attempts: int = 600) -> Path:
    lock = output_dir / ".stage.lock"
    for attempt in range(attempts):
        try:
            lock.mkdir()
            atexit.register(lambda: lock.rmdir() if lock.is_dir() else None)
            return lock
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 900:
                    lock.rmdir()
                    continue
            except (FileNotFoundError, OSError):
                pass
            if attempt == attempts - 1:
                break
            time.sleep(0.1)
    raise TimeoutError(f"timed out waiting for staging lock {lock}")


def digest_to_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list):
        parts = []
        for item in value:
            if isinstance(item, dict):
                date = str(item.get("date", "")).strip()
                summary = str(item.get("summary", "")).strip()
                if date and summary:
                    parts.append(f"{date}: {summary}")
                elif summary:
                    parts.append(summary)
                elif date:
                    parts.append(date)
            elif str(item).strip():
                parts.append(str(item).strip())
        return "\n".join(parts)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
    return str(value or "").strip()


def sort_key(exact_id: str) -> tuple[int, str]:
    return (int(exact_id), exact_id) if exact_id.isdigit() else (2**63 - 1, exact_id)


def revision_sequence(record: dict[str, Any] | None) -> int:
    if not record:
        return 0
    value = record.get("revision_sequence", 0)
    if isinstance(value, bool):
        raise ValueError("revision_sequence must be an integer")
    sequence = int(value)
    if sequence < 0:
        raise ValueError("revision_sequence cannot be negative")
    return sequence


def production_reconciliation_status(
    output_dir: Path,
    staged_final_count: int,
) -> dict[str, Any]:
    """Describe only an exact reconciliation of the current aggregate."""

    path = output_dir / "live_final_reconciliation_latest.json"
    if not path.is_file():
        return {"production_publish_status": "current_aggregate_not_reconciled"}
    try:
        receipt = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"production_publish_status": "reconciliation_receipt_invalid"}
    receipt_count = int(receipt.get("canonicalFinals") or 0)
    passed = (
        receipt_count == staged_final_count
        and int(receipt.get("liveExactIds") or 0) == staged_final_count
        and int(receipt.get("mismatchCountAfter") or 0) == 0
        and receipt.get("allCanonicalFinalsLive") is True
    )
    return {
        "production_publish_status": (
            "exact_live_reconciliation_passed"
            if passed
            else "current_aggregate_not_reconciled"
        ),
        "production_reconciliation_path": str(path),
        "production_reconciliation_sha256": sha256_file(path),
        "production_reconciliation_generated_at": receipt.get("generatedAt"),
        "production_reconciliation_finals": receipt_count,
        "production_reconciliation_mismatches": int(
            receipt.get("mismatchCountAfter") or 0
        ),
    }


def validate_revision(
    exact_id: str,
    record: dict[str, Any],
    existing_assessment: dict[str, Any],
) -> None:
    incoming_sequence = revision_sequence(record)
    existing_sequence = revision_sequence(existing_assessment)
    if incoming_sequence != existing_sequence + 1:
        raise ValueError(
            f"{exact_id}: revision sequence must advance exactly one step"
        )
    revision = record.get("revision")
    if not isinstance(revision, dict) or revision.get("status") != "confirmed":
        raise ValueError(f"{exact_id}: revision is not independently confirmed")
    expected_prior = sha256_bytes(canonical_bytes(existing_assessment))
    if str(revision.get("prior_final_sha256", "")).lower() != expected_prior:
        raise ValueError(f"{exact_id}: revision prior-final hash mismatch")
    for field in ("third_pass_audit_sha256", "adjudication_sha256"):
        value = str(revision.get(field, "")).lower()
        if len(value) != 64 or any(ch not in "0123456789abcdef" for ch in value):
            raise ValueError(f"{exact_id}: invalid revision {field}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validated", required=True, nargs="+", type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--run-slug", default="ars-bs-tam-current")
    parser.add_argument("--snapshot-sha256", required=True)
    parser.add_argument("--actor-key", default="codex")
    parser.add_argument(
        "--lock-attempts",
        type=int,
        default=600,
        help=(
            "Number of 100ms staging-lock attempts. Use 1 for fail-fast "
            "single-record automation."
        ),
    )
    args = parser.parse_args()
    if not 1 <= args.lock_attempts <= 600:
        parser.error("--lock-attempts must be 1-600")

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    acquire_stage_lock(output_dir, attempts=args.lock_attempts)
    queue_path = output_dir / "publish_queue.jsonl"
    assessments_path = output_dir / "final_assessments.jsonl"
    provenance_dir = output_dir / "provenance"
    manifest_path = output_dir / "manifest.json"

    existing_queue = load_jsonl(queue_path) if queue_path.is_file() else []
    existing_assessments = (
        load_jsonl(assessments_path) if assessments_path.is_file() else []
    )
    queue_by_id = {
        str(item.get("netsuiteInternalId", "")).strip(): item
        for item in existing_queue
    }
    assessment_by_id = {
        str(item.get("exact_id", "")).strip(): item
        for item in existing_assessments
    }
    recovered_ids: list[str] = []
    for exact_id in sorted(set(queue_by_id) | set(assessment_by_id), key=sort_key):
        if exact_id in queue_by_id and exact_id in assessment_by_id:
            continue
        provenance_path = provenance_dir / f"{exact_id}.json"
        if not provenance_path.is_file():
            raise ValueError(
                f"{exact_id}: queue/assessment mismatch without provenance"
            )
        provenance_data = json.loads(
            provenance_path.read_text(encoding="utf-8")
        )
        assessment = provenance_data.get("assessment")
        if not isinstance(assessment, dict):
            raise ValueError(f"{exact_id}: provenance has no assessment")
        if exact_id not in assessment_by_id:
            assessment_by_id[exact_id] = assessment
        if exact_id not in queue_by_id:
            validation = assessment.get("validation") or {}
            provenance_bytes = canonical_bytes(provenance_data)
            queue_by_id[exact_id] = {
                "runSlug": str(provenance_data.get("runSlug") or args.run_slug),
                "netsuiteInternalId": exact_id,
                "actorKey": args.actor_key,
                "finalScore": int(assessment.get("final_score")),
                "codexScore": int(assessment.get("reader_candidate_score")),
                "scoreAdjustNote": str(
                    assessment.get("score_adjust_note", "")
                ).strip(),
                "recordDigest": digest_to_text(
                    assessment.get("record_digest")
                ),
                "provenance": {
                    "sha256": sha256_bytes(provenance_bytes),
                    "objectPath": (
                        f"{args.run_slug}/{exact_id}/grade-provenance.json"
                    ),
                    "data": provenance_data,
                },
                "validation": {
                    "status": "passed",
                    "validatedBy": str(
                        validation.get("validated_by", "")
                    ).strip(),
                    "validatedAt": str(
                        validation.get("validated_at", "")
                    ).strip(),
                },
            }
        recovered_ids.append(exact_id)

    added_ids: list[str] = []
    unchanged_ids: list[str] = []
    migrated_ids: list[str] = []
    revised_ids: list[str] = []
    superseded_ids: list[str] = []
    hold_ids: list[str] = []
    conflicts: list[str] = []
    revision_history_dir = output_dir / "revision_history"

    for validated_path in args.validated:
        validated_path = validated_path.resolve()
        for record in load_jsonl(validated_path):
            exact_id = str(record.get("exact_id", "")).strip()
            validator_output_sha256 = sha256_bytes(canonical_bytes(record))
            validation = record.get("validation") or {}
            if validation.get("status") == "hold":
                hold_ids.append(exact_id)
                continue
            if validation.get("status") != "passed":
                raise ValueError(
                    f"{validated_path}: {exact_id} is neither passed nor hold"
                )

            record_digest = digest_to_text(record.get("record_digest"))
            if not record_digest:
                raise ValueError(f"{validated_path}: {exact_id} has blank digest")

            existing_assessment = assessment_by_id.get(exact_id)
            incoming_revision_sequence = revision_sequence(record)
            existing_revision_sequence = revision_sequence(existing_assessment)
            if (
                existing_assessment is not None
                and incoming_revision_sequence < existing_revision_sequence
            ):
                superseded_ids.append(exact_id)
                continue
            allow_revision = (
                existing_assessment is not None
                and incoming_revision_sequence > existing_revision_sequence
            )
            if allow_revision:
                validate_revision(exact_id, record, existing_assessment)

            assessment = {
                **record,
                "exact_id": exact_id,
                "record_digest": record_digest,
                "run_slug": args.run_slug,
                "snapshot_sha256": args.snapshot_sha256,
                "validator_output_path": str(validated_path),
                "validator_output_sha256": validator_output_sha256,
                "validator_hash_scope": "canonical-record",
            }
            provenance_data = {
                "schema": "tam-grade-provenance",
                "version": 1,
                "runSlug": args.run_slug,
                "netsuiteInternalId": exact_id,
                "snapshotSha256": args.snapshot_sha256,
                "pdfSha256": str(record.get("pdf_sha256", "")).lower(),
                "pdfPageCount": int(record.get("pdf_page_count")),
                "recordTextSha256": str(
                    record.get("record_text_sha256", "")
                ).lower(),
                "candidateFileSha256": str(
                    record.get("candidate_file_sha256", "")
                ).lower(),
                "validatorOutputSha256": validator_output_sha256,
                "validatorHashScope": "canonical-record",
                "method": "full-record-reader-plus-independent-full-record-validator",
                "assessment": assessment,
            }
            provenance_bytes = canonical_bytes(provenance_data)
            provenance_sha256 = sha256_bytes(provenance_bytes)
            provenance_path = provenance_dir / f"{exact_id}.json"
            migrated_provenance = False
            if provenance_path.is_file():
                if provenance_path.read_bytes() != provenance_bytes:
                    # A provenance file with no matching canonical assessment is
                    # orphaned staging residue, not a final that can block a
                    # newly validated exact-record correction.  Preserve it for
                    # audit, then let the validated current final recreate the
                    # canonical assessment/payload pair.  A matching assessment
                    # still requires the normal confirmed-revision path.
                    if allow_revision or existing_assessment is None:
                        existing_provenance_bytes = provenance_path.read_bytes()
                        history_prefix = (
                            f"revision-{existing_revision_sequence}"
                            if allow_revision
                            else "orphaned-provenance"
                        )
                        history_name = (
                            f"{history_prefix}-"
                            f"{sha256_bytes(existing_provenance_bytes)}.json"
                        )
                        write_atomic(
                            revision_history_dir / exact_id / history_name,
                            existing_provenance_bytes,
                        )
                        write_atomic(provenance_path, provenance_bytes)
                        if not allow_revision:
                            migrated_ids.append(exact_id)
                    else:
                        existing_provenance = json.loads(
                            provenance_path.read_text(encoding="utf-8")
                        )
                        existing_assessment_for_compare = {
                            key: value
                            for key, value in (
                                existing_provenance.get("assessment") or {}
                            ).items()
                            if key
                            not in {
                                "validator_output_sha256",
                                "validator_hash_scope",
                            }
                        }
                        assessment_for_compare = {
                            key: value
                            for key, value in assessment.items()
                            if key
                            not in {
                                "validator_output_sha256",
                                "validator_hash_scope",
                            }
                        }
                        existing_provenance_for_compare = {
                            key: value
                            for key, value in existing_provenance.items()
                            if key
                            not in {
                                "assessment",
                                "validatorOutputSha256",
                                "validatorHashScope",
                            }
                        }
                        provenance_for_compare = {
                            key: value
                            for key, value in provenance_data.items()
                            if key
                            not in {
                                "assessment",
                                "validatorOutputSha256",
                                "validatorHashScope",
                            }
                        }
                        if (
                            canonical_bytes(existing_assessment_for_compare)
                            != canonical_bytes(assessment_for_compare)
                            or canonical_bytes(existing_provenance_for_compare)
                            != canonical_bytes(provenance_for_compare)
                        ):
                            conflicts.append(
                                f"{exact_id}: existing provenance differs from passed final"
                            )
                            continue
                        write_atomic(provenance_path, provenance_bytes)
                        migrated_provenance = True
            else:
                write_atomic(provenance_path, provenance_bytes)

            publish_payload = {
                "runSlug": args.run_slug,
                "netsuiteInternalId": exact_id,
                "actorKey": args.actor_key,
                "finalScore": int(record.get("final_score")),
                "codexScore": int(record.get("reader_candidate_score")),
                "scoreAdjustNote": str(record.get("score_adjust_note", "")).strip(),
                "recordDigest": record_digest,
                "provenance": {
                    "sha256": provenance_sha256,
                    "objectPath": (
                        f"{args.run_slug}/{exact_id}/grade-provenance.json"
                    ),
                    "data": provenance_data,
                },
                "validation": {
                    "status": "passed",
                    "validatedBy": str(validation.get("validated_by", "")).strip(),
                    "validatedAt": str(validation.get("validated_at", "")).strip(),
                },
            }

            existing_payload = queue_by_id.get(exact_id)
            if existing_payload is not None:
                if (
                    canonical_bytes(existing_payload)
                    != canonical_bytes(publish_payload)
                    or canonical_bytes(existing_assessment)
                    != canonical_bytes(assessment)
                ):
                    if allow_revision:
                        queue_by_id[exact_id] = publish_payload
                        assessment_by_id[exact_id] = assessment
                        revised_ids.append(exact_id)
                        continue
                    if migrated_provenance:
                        queue_by_id[exact_id] = publish_payload
                        assessment_by_id[exact_id] = assessment
                        migrated_ids.append(exact_id)
                        continue
                    conflicts.append(
                        f"{exact_id}: existing staged final differs from new final"
                    )
                    continue
                unchanged_ids.append(exact_id)
                continue

            queue_by_id[exact_id] = publish_payload
            assessment_by_id[exact_id] = assessment
            added_ids.append(exact_id)

    if conflicts:
        print(
            json.dumps(
                {
                    "status": "conflict",
                    "conflicts": conflicts,
                    "added_ids_not_committed": added_ids,
                },
                indent=2,
            )
        )
        return 1

    ordered_ids = sorted(queue_by_id, key=sort_key)
    queue_bytes = b"".join(
        canonical_bytes(queue_by_id[exact_id]) + b"\n" for exact_id in ordered_ids
    )
    assessment_bytes = b"".join(
        canonical_bytes(assessment_by_id[exact_id]) + b"\n"
        for exact_id in ordered_ids
    )
    write_atomic(queue_path, queue_bytes)
    write_atomic(assessments_path, assessment_bytes)

    production_status = production_reconciliation_status(
        output_dir, len(ordered_ids)
    )
    manifest = {
        "schema": "tam-local-final-publication-queue",
        "version": 1,
        "run_slug": args.run_slug,
        "snapshot_sha256": args.snapshot_sha256,
        "queue_path": str(queue_path),
        "queue_sha256": sha256_bytes(queue_bytes),
        "assessment_path": str(assessments_path),
        "assessment_sha256": sha256_bytes(assessment_bytes),
        "staged_final_count": len(ordered_ids),
        "added_ids": sorted(added_ids, key=sort_key),
        "unchanged_ids": sorted(unchanged_ids, key=sort_key),
        "migrated_ids": sorted(set(migrated_ids), key=sort_key),
        "revised_ids": sorted(set(revised_ids), key=sort_key),
        "superseded_ids": sorted(set(superseded_ids), key=sort_key),
        "recovered_ids": sorted(set(recovered_ids), key=sort_key),
        "hold_ids": sorted(set(hold_ids), key=sort_key),
        **production_status,
    }
    manifest_bytes = json.dumps(
        manifest,
        ensure_ascii=True,
        indent=2,
        sort_keys=True,
    ).encode("utf-8")
    write_atomic(manifest_path, manifest_bytes)
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
