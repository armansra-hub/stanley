"""Local comparison of sourced public developments with canonical CRM chronology.

Fetches only public evidence by exact ID. CRM history, dates and summaries never
leave the computer; this report neither changes nor enters a grading prompt.
"""
from datetime import date
import json
from pathlib import Path
from urllib.request import Request, build_opener

try:
    from . import tam_evidence_index as indexer
    from . import tam_jev_annotations as annotations
    from .tam_navigation_bridge import atomic_json
except ImportError:
    import tam_evidence_index as indexer
    import tam_jev_annotations as annotations
    from tam_navigation_bridge import atomic_json

ENDPOINT = "https://jarvis-sable-eta.vercel.app/api/agent/intelligence/context"


def fetch_public_context(internal_id, token, bypass=""):
    indexer.exact_id(internal_id)
    headers = {"Authorization": f"Bearer {token}", "x-agent-name": "codex"}
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    request = Request(ENDPOINT + "?internalId=" + internal_id, headers=headers, method="GET")
    with build_opener(annotations.NoRedirect()).open(request, timeout=15) as response:
        raw = response.read(1024 * 1024 + 1)
    indexer.need(len(raw) <= 1024 * 1024, "public context too large")
    value = json.loads(raw)
    indexer.need(value.get("schema") == "stanley-public-account-context" and value.get("version") == 1
                 and value.get("internalId") == internal_id, "public context identity mismatch")
    indexer.need(isinstance(value.get("observations"), list) and len(value["observations"]) <= 100, "public context invalid")
    return value


def exact_date(value):
    if not isinstance(value, str) or len(value) != 10:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def compare(internal_id, validation, public, *, validator_sha256):
    indexer.need(public.get("internalId") == internal_id, "public context identity mismatch")
    indexer.need(validation.get("validation_status") == "passed", "canonical full-read validation required")
    indexer.hash_value(validator_sha256, "validator_sha256")
    human_date = exact_date(validation.get("newest_human_interaction_date"))
    rows = []
    for source in public["observations"]:
        event = exact_date(source.get("eventDate"))
        delta = (event - human_date).days if event and human_date else None
        timing = "unknown_event_date" if not event else "unknown_crm_date" if not human_date else (
            "after_last_substantive_interaction" if delta > 0 else "same_day" if delta == 0 else "before_last_substantive_interaction")
        rows.append({**source, "crmComparison": timing, "daysAfterInteraction": delta})
    rows.sort(key=lambda row: (row["crmComparison"] == "after_last_substantive_interaction", row.get("eventDate") or ""), reverse=True)
    return {"schema": "tam-local-public-crm-comparison", "version": 1, "internal_id": internal_id,
            "validator_sha256": validator_sha256, "public_context_sha256": indexer.digest(indexer.encoded(public)),
            "last_substantive_interaction": {"date": validation.get("newest_human_interaction_date"),
                "summary": validation.get("newest_human_interaction_summary"), "basis": "canonical complete reader and independent validator"},
            "observations": rows, "coverage": public["coverage"],
            "note": "Separate local research context, not a grade amendment or buying-intent claim. Later public evidence does not establish that an old objection was reversed. Related/unknown companies remain labeled; missing event dates remain unknown."}


def refresh_comparison(internal_id, validation, *, validator_sha256, root, token, bypass="", fetch=fetch_public_context):
    """One public read and private local artifact; failures never block publishing."""
    try:
        public = fetch(internal_id, token, bypass)
        result = compare(internal_id, validation, public, validator_sha256=validator_sha256)
        key = indexer.digest(indexer.encoded({"validator": validator_sha256, "public": result["public_context_sha256"]}))
        folder = Path(root) / internal_id
        path = folder / f"{key[:24]}.json"
        atomic_json(path, result)
        atomic_json(folder / "latest.json", {"path": str(path), "sha256": indexer.digest(path.read_bytes()),
                                            "internal_id": internal_id, "validator_sha256": validator_sha256})
        return {"status": "complete", "path": str(path), "observations": len(result["observations"]),
                "after_last_interaction": sum(row["crmComparison"] == "after_last_substantive_interaction" for row in result["observations"]),
                "private_requests_sent": 0}
    except Exception:
        return {"status": "public_context_unavailable_grade_unchanged", "private_requests_sent": 0}
