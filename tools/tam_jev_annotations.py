#!/usr/bin/env python3
"""Optional, explicit excerpt annotations through Stanley's budgeted private route.

Does not import a grader, inspect a corpus, claim work, or publish grades.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
from urllib.request import Request, build_opener, HTTPRedirectHandler

from tam_evidence_index import read_explicit, write_new, exact_id, digest, need

ENDPOINT = "https://jarvis-sable-eta.vercel.app/api/agent/intelligence/evaluate"
QUESTION_VERSION = "stanley-evidence-v2"
CRITERIA = [
    {"id": "substantive_interaction", "instructions": "Does this excerpt contain a substantive human exchange about the prospect's own business situation? Generic unanswered cadence, no-answer calls, marketing invitations and automated notices alone do not establish a human exchange."},
    {"id": "systems_evidence", "instructions": "Does a clearly attributable statement describe the prospect's actual current business systems or a specific planned systems change? Distinguish the prospect's statements from a seller's hypothesis or template."},
    {"id": "budget_evidence", "instructions": "Does an attributable statement describe this prospect's budget, financial capacity, affordability concern or a concrete buying-cost discussion? A seller's generic pricing alone does not establish budget."},
    {"id": "timing_evidence", "instructions": "Does an attributable statement describe this prospect's own evaluation, implementation or renewal timing? A generic request to schedule a call is insufficient. Do not infer missing dates."},
]


def prepare(raw, pinned_hash, internal_id, references, model="jev-1.13.0"):
    need(digest(raw) == pinned_hash, "index hash mismatch")
    value = json.loads(raw.decode("utf-8"))
    need(value.get("schema") == "tam-evidence-navigation-index" and value.get("version") == 1, "unsupported index")
    need(value.get("binding", {}).get("internal_id") == exact_id(internal_id), "exact ID mismatch")
    need(1 <= len(references) <= 40 and len(set(references)) == len(references), "select 1..40 unique lines")
    lines = {f"{document['id']}:{line['line']}": line for document in value["documents"] for line in document["lines"]}
    need(all(reference in lines for reference in references), "unknown line reference")
    selected = [lines[reference] for reference in references]
    # Caller selects surrounding context too; never infer or silently expand scope.
    text = "\n".join(f"[{reference}] {line['text']}" for reference, line in zip(references, selected))
    need(len(text.encode("utf-8")) <= 12000, "excerpt exceeds endpoint capacity")
    binding = {"internal_id": internal_id, "index_sha256": pinned_hash, "source_sha256": value["binding"]["source_sha256"],
               "references": references, "model": model, "question_version": QUESTION_VERSION, "criteria": CRITERIA}
    cache_key = hashlib.sha256(json.dumps(binding, sort_keys=True).encode()).hexdigest()
    return {"schema": "tam-jev-excerpt-request", "version": 1, "binding": binding, "cache_key": cache_key,
            "spans": selected, "payload": {"text": text, "criteria": CRITERIA}}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def evaluate(prepared, token, transport=None):
    need(bool(token), "dedicated agent token required")
    if transport is None:
        request = Request(ENDPOINT, data=json.dumps(prepared["payload"]).encode(), method="POST",
                          headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "x-agent-name": "codex"})
        with build_opener(NoRedirect()).open(request, timeout=30) as response:
            body = response.read(262145)
            need(len(body) <= 262144, "response too large")
            result = json.loads(body)
    else:
        result = transport(prepared["payload"])
    need(isinstance(result, dict) and result.get("ok") is True, "annotation unavailable")
    need(result.get("model") == prepared["binding"]["model"] and result.get("questionVersion") == prepared["binding"]["question_version"], "model contract changed")
    criteria = result.get("criteria", {})
    need(set(criteria) == {criterion["id"] for criterion in CRITERIA}, "criteria incomplete")
    need(all(type(probability) in (int, float) and math.isfinite(probability) and 0 <= probability <= 1 for probability in criteria.values()), "invalid annotation")
    return {"schema": "tam-jev-excerpt-annotations", "version": 1, "binding": prepared["binding"], "cache_key": prepared["cache_key"],
            "spans": prepared["spans"], "annotations": criteria, "usage": result.get("usage"),
            "navigation_only": True, "full_reader_required": True, "independent_full_validator_required": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", required=True, type=Path)
    parser.add_argument("--index-sha256", required=True)
    parser.add_argument("--id", required=True)
    parser.add_argument("--line", required=True, action="append", help="Exact document_id:line, including needed surrounding context")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--evaluate", action="store_true", help="Send only these selected excerpts; otherwise prepare locally")
    args = parser.parse_args()
    try:
        prepared = prepare(read_explicit(args.index, 64 * 1024 * 1024), args.index_sha256, args.id, args.line)
        if not args.evaluate:
            write_new(args.output, prepared)
            print(json.dumps({"prepared": True, "sent": False, "cache_key": prepared["cache_key"]}))
            return 0
        token = os.environ.get("CODEX_AGENT_TOKEN") or os.environ.get("AGENT_TOKEN")
        need(bool(token), "dedicated agent token required")
        need(not args.output.exists(), "output already exists")
        receipt = args.output.with_name(args.output.name + ".request.json")
        # A lost HTTP outcome must not silently lead to another paid request.
        write_new(receipt, {"cache_key": prepared["cache_key"], "status": "pending_or_uncertain", "endpoint": ENDPOINT})
        result = evaluate(prepared, token)
        write_new(args.output, result)
        receipt.write_text(json.dumps({"cache_key": prepared["cache_key"], "status": "complete", "output_sha256": digest(args.output.read_bytes())}) + "\n", encoding="utf-8")
        print(json.dumps({"annotated": True, "cache_key": prepared["cache_key"]}))
        return 0
    except Exception:
        # No source, provider body or credential appears in terminal output.
        print(json.dumps({"error": "annotation_unavailable", "detail": "Check local inputs, existing receipt, endpoint enablement and dedicated token. Do not retry an uncertain request blindly."}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
