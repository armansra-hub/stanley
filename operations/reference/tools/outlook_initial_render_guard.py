"""Fail-closed validation for Outlook initial-email rendering.

The Outlook web editor can silently drop later paragraphs when a bulk typing
operation refocuses the parent contenteditable after Outlook has re-rendered a
new child block. This guard checks the complete prospect-facing region above
the automatic signature before a message may be sent or scheduled.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass


SIGNATURE = "Arman Sra"
TITLE = "Account Executive"


@dataclass(frozen=True)
class InitialRenderResult:
    ok: bool
    failures: tuple[str, ...]
    signature_count: int
    title_count: int
    block_counts: tuple[int, ...]
    block_offsets: tuple[int, ...]


def _normalize(value: str) -> str:
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"[ \t]+\n", "\n", value)


def validate_initial(body: str, expected_blocks: list[str]) -> InitialRenderResult:
    normalized = _normalize(body)
    signature_at = normalized.find(SIGNATURE)
    prospect_region = normalized if signature_at < 0 else normalized[:signature_at]
    signature_count = normalized.count(SIGNATURE)
    title_count = normalized.count(TITLE)
    counts = tuple(prospect_region.count(block) for block in expected_blocks)
    offsets = tuple(prospect_region.find(block) for block in expected_blocks)
    failures: list[str] = []

    if signature_count != 1 or title_count != 1:
        failures.append("automatic_signature_count_not_one")
    if "\u2014" in prospect_region:
        failures.append("em_dash_present")
    for index, count in enumerate(counts):
        if count != 1:
            failures.append(f"block_{index}_count_not_one")
    if all(count == 1 for count in counts) and list(offsets) != sorted(offsets):
        failures.append("initial_copy_out_of_order")
    if expected_blocks and expected_blocks[-1] != "Thanks,":
        failures.append("closing_not_canonical")

    return InitialRenderResult(
        ok=not failures,
        failures=tuple(dict.fromkeys(failures)),
        signature_count=signature_count,
        title_count=title_count,
        block_counts=counts,
        block_offsets=offsets,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--body-file", required=True)
    parser.add_argument("--blocks-file", required=True)
    args = parser.parse_args()
    with open(args.body_file, "r", encoding="utf-8") as handle:
        body = handle.read()
    with open(args.blocks_file, "r", encoding="utf-8") as handle:
        blocks = json.load(handle)
    if not isinstance(blocks, list) or not all(isinstance(v, str) for v in blocks):
        raise ValueError("blocks-file must contain a JSON array of strings")
    result = validate_initial(body, blocks)
    print(json.dumps(asdict(result), ensure_ascii=False, separators=(",", ":")))
    return 0 if result.ok else 2


if __name__ == "__main__":
    sys.exit(main())
