"""Run-fenced pending-selector pause/resume, with durable no-repost recovery.

Uses the existing authenticated TAM transport. Does not modify runtime files,
automation controls, canonical pointers, claims, records or grade publication.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import urllib.parse
import uuid
from datetime import datetime, timezone
import tam_changed_evidence as canonical

ENDPOINT = "/api/cron/tam-coordination"

def require(value, message):
    if not value:
        raise ValueError(message)

def now(): return datetime.now(timezone.utc).isoformat()

def scope(root):
    _, mission, context_path, context = canonical.canonical(root)
    result = {"runSlug": context["run_slug"], "seedId": context["checkpoint_seed_id"],
              "context": canonical.reference(root, context_path)}
    uuid.UUID(result["seedId"])
    require(result["runSlug"] and mission["activeGradingRound"]["checkpointSeedId"] == result["seedId"], "Canonical run/seed differs")
    return result

def api_for(root):
    _, initializer = canonical.modules(root)
    return initializer.Api()

def read_gate(api, exact):
    query = urllib.parse.urlencode({"view": "dispatch_gate", "run": exact["runSlug"], "seed": exact["seedId"]})
    gate = api.request("GET", ENDPOINT + "?" + query).get("gate", {})
    require(gate.get("runSlug") == exact["runSlug"] and gate.get("seedId") == exact["seedId"]
            and isinstance(gate.get("paused"), bool) and type(gate.get("revision")) is int and gate["revision"] >= 0,
            "Exact dispatch gate readback differs")
    return gate

def snapshot(root, api=None):
    exact = scope(root)
    return {"scope": exact, "gate": read_gate(api or api_for(root), exact)}

def satisfied(intent, gate):
    payload = intent["payload"]
    return (gate.get("runId") == intent["before"]["runId"] and gate.get("runSlug") == payload["runSlug"]
            and gate.get("seedId") == payload["seedId"] and gate.get("operationId") == payload["operationId"]
            and gate.get("revision") == payload["expectedRevision"] + 1 and gate.get("paused") is payload["paused"])

def set_gate(root, directory, paused, api=None):
    directory = canonical.inside(root, directory)
    require(not directory.exists(), "Use a new receipt directory; existing intent must be reconciled, never reposted")
    directory.mkdir(parents=True)
    api = api or api_for(root)
    current = snapshot(root, api)
    exact, before = current["scope"], current["gate"]
    if before["paused"] is paused:
        receipt = {"status": "already_requested_state", "scope": exact, "gate": before, "at": now()}
        canonical.write(directory / "result.json", receipt)
        return receipt
    payload = {"action": "dispatch_gate_set", "runSlug": exact["runSlug"], "seedId": exact["seedId"],
               "operationId": str(uuid.uuid4()), "expectedRevision": before["revision"],
               "expectedPaused": before["paused"], "paused": paused, "actorKey": "codex"}
    intent = {"schema": "tam-dispatch-gate-intent", "version": 1, "scope": exact, "before": before,
              "payload": payload, "payloadSha256": canonical.sha(canonical.raw(payload)), "createdAt": now()}
    # Persist before sending. Even a timeout keeps this exact operation for GET-only recovery.
    canonical.write(directory / "intent.json", intent)
    try:
        result = api.request("POST", ENDPOINT, payload)
        canonical.write(directory / "response.json", result)
        require(satisfied(intent, result.get("gate", {})) and result.get("operation", {}).get("operationId") == payload["operationId"],
                "Dispatch gate response differs; reconcile the stored operation")
        after = read_gate(api, exact)
        require(satisfied(intent, after), "Dispatch gate readback differs; reconcile without reposting")
    except Exception:
        canonical.write(directory / "result.json", {"status": "pending_reconciliation", "operationId": payload["operationId"], "at": now()})
        raise
    receipt = {"status": "complete", "operationId": payload["operationId"], "scope": exact, "gate": after, "at": now()}
    canonical.write(directory / "result.json", receipt)
    return receipt

def reconcile(root, directory, api=None):
    directory = canonical.inside(root, directory)
    intent = canonical.read(directory / "intent.json")
    require(intent.get("schema") == "tam-dispatch-gate-intent" and intent.get("payloadSha256") == canonical.sha(canonical.raw(intent["payload"])), "Stored dispatch intent differs")
    canonical.bound(root, intent["scope"]["context"])
    gate = read_gate(api or api_for(root), intent["scope"])
    require(satisfied(intent, gate), "Exact operation is not the current gate state; retain intent and investigate without reposting")
    receipt = {"status": "complete", "readOnlyReconciled": True, "operationId": intent["payload"]["operationId"], "scope": intent["scope"], "gate": gate, "at": now()}
    canonical.write(directory / "result.json", receipt)
    return receipt

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["snapshot", "pause", "resume", "reconcile"])
    parser.add_argument("--root", type=Path, default=canonical.workspace())
    parser.add_argument("--directory", type=Path)
    args = parser.parse_args()
    require(args.command == "snapshot" or args.directory is not None, "A new or existing exact receipt directory is required")
    root = args.root.resolve()
    if args.command == "snapshot": result = snapshot(root)
    elif args.command == "reconcile": result = reconcile(root, args.directory)
    else: result = set_gate(root, args.directory, args.command == "pause")
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__": main()
