"""Jev MCP: typed native answers via the existing authenticated Stanley service.

No SDK dependency, browser, credential in configuration, or always-running daemon.
Codex owns this stdio process. Private answer receipts stay in the local workspace.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.request

BASE = "https://jarvis-sable-eta.vercel.app"
VERSION = "1.0.0"
ROOT = Path(os.environ.get("STANLEY_WORKSPACE", str(Path(__file__).resolve().parents[2]))).resolve()
CACHE = ROOT / "outputs" / "jev_codex_connector" / "native_receipts"
MAX_BYTES = 50_000

def credentials() -> dict[str, str]:
    project = ROOT / "stanley-source" / "stanley-main"
    values = {}
    for path in [project / ".env.local", project / ".vercel" / ".env.production.local"]:
        if path.is_file():
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                key, sep, value = line.partition("=")
                if sep and key.strip() in {"CODEX_AGENT_TOKEN", "AGENT_TOKEN", "VERCEL_AUTOMATION_BYPASS_SECRET"}:
                    value = value.strip().strip('"').strip("'")
                    if value and value.upper() not in {"[SENSITIVE]", "[REDACTED]", "REDACTED"}:
                        values.setdefault(key.strip(), value)
    token = os.environ.get("CODEX_AGENT_TOKEN") or os.environ.get("AGENT_TOKEN") or values.get("CODEX_AGENT_TOKEN") or values.get("AGENT_TOKEN")
    token_path = project / ".vercel" / ".codex-agent-token"
    if not token and token_path.is_file():
        token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Stanley agent credential unavailable")
    bypass = os.environ.get("VERCEL_AUTOMATION_BYPASS_SECRET") or values.get("VERCEL_AUTOMATION_BYPASS_SECRET")
    bypass_path = project / ".vercel" / ".automation-bypass"
    if not bypass and bypass_path.is_file():
        bypass = bypass_path.read_text(encoding="utf-8").strip()
    headers = {"x-agent-token": token, "x-agent-name": "codex", "Content-Type": "application/json"}
    if bypass:
        headers["x-vercel-protection-bypass"] = bypass
    return headers

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def request(path: str, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers=credentials())
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=55) as response:
            raw = response.read(1_048_577)
            if len(raw) > 1_048_576:
                raise RuntimeError("Stanley response exceeded the receipt limit")
            return json.loads(raw)
    except urllib.error.HTTPError as error:
        # The fixed route only returns bounded application errors/native answers.
        try:
            result = json.loads(error.read(1_048_576))
        except Exception:
            result = {"error": "stanley_http_" + str(error.code)}
        if isinstance(result, dict):
            result["httpStatus"] = error.code
            return result
        return {"error": "stanley_http_" + str(error.code), "httpStatus": error.code}

def atomic_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def evaluate(arguments: dict):
    if set(arguments) - {"state", "questions", "privacy"}:
        raise ValueError("Only state, questions and privacy are accepted")
    body = {"state": arguments.get("state"), "questions": arguments.get("questions"),
            "privacy": arguments.get("privacy", "private_excerpt")}
    if body["state"] is None or not isinstance(body["questions"], dict) or not 1 <= len(body["questions"]) <= 32:
        raise ValueError("Provide source state and 1–32 typed questions")
    if body["privacy"] not in {"public", "private_excerpt"}:
        raise ValueError("privacy must be public or private_excerpt")
    packed = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(packed) > MAX_BYTES:
        raise ValueError("Request too large; divide into source-bounded questions without dropping useful evidence")
    digest = hashlib.sha256(b"jev-codex-v1\0" + packed).hexdigest()
    CACHE.mkdir(parents=True, exist_ok=True)
    receipt, intent = CACHE / (digest + ".json"), CACHE / (digest + ".intent")
    if receipt.is_file():
        result = json.loads(receipt.read_text(encoding="utf-8"))
        return {"requestFingerprint": digest, "localReuse": True, **result}
    try:
        fd = os.open(intent, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return {"error": "request_in_progress_or_acceptance_unknown", "requestFingerprint": digest,
                "instruction": "Do not repeat the paid request. Reconcile the existing local intent/receipt first."}
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump({"requestFingerprint": digest, "privacy": body["privacy"]}, handle)
        handle.flush()
        os.fsync(handle.fileno())
    try:
        result = request("/api/agent/intelligence/native", body)
    except Exception:
        # Keep uncertainty durable; never blindly resend an accepted private request.
        return {"error": "provider_acceptance_unknown", "requestFingerprint": digest,
                "instruction": "Preserved request intent. Do not retry without reconciling its outcome."}
    if result.get("status") in {"busy", "budget_deferred"} or result.get("httpStatus") in {400,401,403,404,409,429}:
        intent.unlink(missing_ok=True)
        return {"requestFingerprint": digest, **result}
    if result.get("status") == "complete":
        atomic_json(receipt, result)  # answer is durable before releasing the local request
        intent.unlink(missing_ok=True)
        return {"requestFingerprint": digest, "localReuse": False, **result}
    return {"requestFingerprint": digest, **result, "instruction": "Outcome not confirmed; existing intent preserved."}

QUESTION_SCHEMA = {"type": "object", "required": ["type", "instructions"], "properties": {
    "type": {"type": "string", "enum": ["noul", "choice", "score"]},
    "instructions": {"type": "string", "description": "Explicit question grounded in the supplied source and target identity."},
    "criteria": {"oneOf": [{"type": "object", "additionalProperties": {"type": "string"}},
                            {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 10}]}
}, "additionalProperties": False}
TOOLS = [
    {"name": "jev_status", "description": "Check the direct TypeSafe Jev connection and model without a paid model request.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
    {"name": "jev_evaluate", "description": (
        "Ask Jev parallel typed questions about supplied evidence: noul=yes/no probability, choice=choose named criteria, "
        "score=ordered rubric. Returns unchanged native answers/distributions and usage. Use for first-pass classification, "
        "relevance ranking, semantic matching or candidate selection; not to double-check another model's output. "
        "Include identity/domain/address, source/date and all relevant context. No browsing or invented facts. "
        "Costs TypeSafe usage through Stanley; exact completed requests reuse local receipts. Private excerpts are the default. "
        "Use privacy=public only for wholly public input. Never retry an unknown-acceptance intent."),
     "inputSchema": {"type": "object", "required": ["state", "questions"], "properties": {
         "state": {"description": "Source evidence and useful context as JSON or text."},
         "questions": {"type": "object", "minProperties": 1, "maxProperties": 32, "additionalProperties": QUESTION_SCHEMA},
         "privacy": {"type": "string", "enum": ["public", "private_excerpt"], "default": "private_excerpt"}},
         "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": True}},
    {"name": "jev_account_context", "description": "Read Stanley's existing public intelligence for one exact NetSuite Internal ID; no model call or grade change.",
     "inputSchema": {"type": "object", "required": ["internalId"], "properties": {"internalId": {"type": "string", "pattern": "^[0-9]+$"}}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": True}},
]

def dispatch(message: dict):
    method, params = message.get("method"), message.get("params") or {}
    if method == "initialize":
        version = params.get("protocolVersion")
        return {"protocolVersion": version if version in {"2024-11-05", "2025-03-26", "2025-06-18"} else "2024-11-05",
                "capabilities": {"tools": {}}, "serverInfo": {"name": "stanley-jev", "version": VERSION},
                "instructions": "Use Jev for useful first-pass classification/ranking, not redundant verification. Native judgments are preserved. Do not send unrelated private information."}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        args, name = params.get("arguments") or {}, params.get("name")
        if not isinstance(args, dict):
            raise ValueError("Tool arguments must be an object")
        if name == "jev_status":
            result = request("/api/agent/intelligence/native")
        elif name == "jev_evaluate":
            result = evaluate(args)
        elif name == "jev_account_context":
            internal_id = str(args.get("internalId", ""))
            if not re.fullmatch(r"[0-9]+", internal_id):
                raise ValueError("Exact numeric NetSuite Internal ID required")
            result = request("/api/agent/intelligence/context?internalId=" + internal_id)
        else:
            raise ValueError("Unknown tool")
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                "isError": bool(result.get("error") or result.get("httpStatus", 200) >= 400)}
    raise ValueError("Unknown method")

def main():
    for line in sys.stdin.buffer:
        if len(line) > 1_048_576:
            continue
        try:
            message = json.loads(line)
            if not isinstance(message, dict) or "id" not in message:
                continue
            response = {"jsonrpc": "2.0", "id": message["id"], "result": dispatch(message)}
        except Exception as error:
            # Never serialize credential-bearing Request/HTTP exception details.
            detail = str(error) if isinstance(error, ValueError) else "Connector operation unavailable"
            response = {"jsonrpc": "2.0", "id": message.get("id") if isinstance(locals().get("message"), dict) else None,
                        "error": {"code": -32602 if isinstance(error, ValueError) else -32603, "message": detail}}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
