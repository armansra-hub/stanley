"""Fail-closed validation for Outlook cadence reply rendering.

The Outlook connector returns message bodies as a Markdown-like text stream.
This guard validates only the current reply above the automatic signature and
quoted history. It is intentionally narrow: it catches the 2026-08-07 reply
editor corruption without changing cadence copy or business logic.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass


NOTE = (
    "Just wanted to make sure this didn’t get buried in your inbox. "
    "Did you get a chance to view my note below?"
)
LOOKING = "Looking forward to speaking,"
THANKS = "Thanks,"
SIGNATURE = "Arman Sra"
TITLE = "Account Executive"
CLASSIFICATION = "Oracle Confidential"


@dataclass(frozen=True)
class RenderResult:
    ok: bool
    failures: tuple[str, ...]
    classification_count: int
    signature_count: int
    phrase_counts: dict[str, int]
    phrase_offsets: dict[str, int]
    note_to_looking_newlines: int | None


def _normalize_line_endings(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    # Connector-rendered Markdown uses two trailing spaces for hard breaks.
    return re.sub(r"[ \t]+\n", "\n", value)


def _current_reply_region(body: str) -> tuple[str, str]:
    normalized = _normalize_line_endings(body)
    signature_at = normalized.find(SIGNATURE)
    if signature_at < 0:
        return normalized, ""
    quote_candidates = [
        pos
        for marker in ("\n* * *\n", "\n**From:**", "\nFrom:")
        if (pos := normalized.find(marker, signature_at)) >= 0
    ]
    quote_at = min(quote_candidates) if quote_candidates else len(normalized)
    return normalized[:quote_at], normalized[quote_at:]


def validate_followup1(body: str, first_name: str) -> RenderResult:
    current, quote = _current_reply_region(body)
    greeting = f"Hi {first_name},"
    phrases = {
        "greeting": greeting,
        "note": NOTE,
        "looking": LOOKING,
    }
    counts = {name: current.count(value) for name, value in phrases.items()}
    counts["thanks"] = current.count(THANKS)
    offsets = {name: current.find(value) for name, value in phrases.items()}
    offsets["thanks"] = current.find(THANKS)
    classification_count = current.count(CLASSIFICATION)
    signature_count = current.count(SIGNATURE)
    failures: list[str] = []

    if classification_count != 1:
        failures.append("classification_count_not_one")
    if signature_count != 1 or current.count(TITLE) != 1:
        failures.append("automatic_signature_count_not_one")
    if not quote or "From:" not in quote:
        failures.append("quoted_history_missing")

    for name in ("greeting", "note", "looking"):
        count = counts[name]
        if count != 1:
            failures.append(f"{name}_count_not_one")

    if counts["thanks"] != 0:
        failures.append("unexpected_thanks_present")

    if all(counts[name] == 1 for name in ("greeting", "note", "looking")):
        ordered = [offsets[name] for name in ("greeting", "note", "looking")]
        if ordered != sorted(ordered):
            failures.append("followup_copy_out_of_order")

    gap: int | None = None
    if counts["note"] == 1 and counts["looking"] == 1:
        note_end = offsets["note"] + len(NOTE)
        between = current[note_end : offsets["looking"]]
        # Outlook normally renders one paragraph boundary as 2 or 4 newlines
        # in connector text. More than 4 means empty reply paragraphs leaked in.
        if between and set(between) <= {"\n"}:
            gap = len(between)
            if gap > 4:
                failures.append("excess_blank_paragraphs_after_note")
        elif between.strip():
            failures.append("unexpected_content_between_note_and_looking")

    return RenderResult(
        ok=not failures,
        failures=tuple(dict.fromkeys(failures)),
        classification_count=classification_count,
        signature_count=signature_count,
        phrase_counts=counts,
        phrase_offsets=offsets,
        note_to_looking_newlines=gap,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--body-file", required=True)
    parser.add_argument("--first-name", required=True)
    args = parser.parse_args()
    with open(args.body_file, "r", encoding="utf-8") as handle:
        result = validate_followup1(handle.read(), args.first_name)
    print(json.dumps(asdict(result), ensure_ascii=False, separators=(",", ":")))
    return 0 if result.ok else 2


if __name__ == "__main__":
    sys.exit(main())
