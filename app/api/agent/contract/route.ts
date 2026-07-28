import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";

/**
 * Self-describing protocol for the agent bridge — one URL an agent can hit to
 * learn the whole interface plus the current state of the work, so neither side
 * has to guess at the other's schema. Also the fastest way to confirm a token works.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const db = serviceClient();

  const [msgs, tasks, docs, graded] = await Promise.all([
    db.from("agent_messages").select("*", { count: "exact", head: true }).is("read_at", null),
    db.from("agent_tasks").select("*", { count: "exact", head: true }).in("state", ["queued", "running", "blocked"]),
    db.from("lead_documents").select("*", { count: "exact", head: true }),
    db.from("companies").select("*", { count: "exact", head: true }).not("codex_score", "is", null),
  ]);

  return NextResponse.json({
    bridge: "Stanley agent bridge v1",
    auth: "every endpoint needs the shared secret: 'Authorization: Bearer <token>' or 'x-agent-token: <token>'. Identify yourself with 'x-agent-name: codex' or 'claude'.",
    endpoints: {
      "GET  /api/agent/contract": "this document + live counts",
      "GET  /api/agent/messages?to=codex&unread=1": "read your inbox (marks read; add &peek=1 to leave unread)",
      "POST /api/agent/messages": "{ to: 'claude'|'codex'|'arman'|'all', subject, body?, kind?: note|status|question|answer|handoff|error|contract, ref?: {} }",
      "GET  /api/agent/status": "the live board — who is working on what, with stall detection",
      "POST /api/agent/status": "{ title, state?, done?, total?, note?, detail? } → returns taskId; pass taskId back to update/finish",
      "GET  /api/agent/read?table=companies&…": "READ ANY BUSINESS TABLE. Full PostgREST filters (eq/gt/like/in/or), select, order, limit (max 1000). Call without ?table to list what's readable.",
      "GET  /api/agent/lead?internalId=123": "everything about one lead in one call — company rows, live triggers, record text, prior scores. Also ?name=<fuzzy>.",
      "GET  /api/agent/documents?internalId=123": "read a lead's stored record text",
      "POST /api/agent/documents": "{ docs: [{ internalId, body, docType?, source?, title?, capturedAt? }] } — max 200/request",
      "GET  /api/agent/scores": "the grade-row field reference and the scoring rules enforced on write",
      "POST /api/agent/scores": "{ rows: [...], dryRun?, label?, note? } — max 1000/request; ALWAYS dryRun first",
    },
    state: {
      unreadMessages: msgs.count ?? 0,
      liveTasks: tasks.count ?? 0,
      leadDocuments: docs.count ?? 0,
      companiesWithCodexScore: graded.count ?? 0,
    },
    knownHistory: [
      "2026-07-15: a full-record regrade landed for 6,912 of 7,402 TAM leads (93.4%) via a since-deleted endpoint. Those grades are LIVE in companies.codex_score / tam_score with score_adjust_note 'Codex full-record regrade 2026-07-15'.",
      "That import set tam_score = codex_score, which overwrote Stanley's ±15 outside-signal adjustments. Re-running system/codex_rescore.py re-applies them.",
      "490 TAM leads (6.6%) never received that regrade — check before regrading everything from scratch.",
      "The import that broke did so on one field: revisitOn. An omitted key is undefined (not null), so a strict /^\\d{4}-\\d{2}-\\d{2}$/ test rejected the whole 250-row batch with no row index. This bridge accepts loose dates and reports errors per row.",
    ],
    reading: [
      "You have READ access to every business table via /api/agent/read — companies, triggers, exports, app_events, score_snapshots and more. Call it with no ?table to see the list.",
      "The database key is deliberately NOT shared: /api/agent/read is GET-only over an allowlist, so your token can read everything but cannot delete or overwrite anything.",
      "Examples: ?table=companies&tam_score=gte.40&order=tam_score.desc | ?table=triggers&type=in.(funding,ma)&order=detected_at.desc | ?table=companies&score_adjust_note=is.null&netsuite_internal_id=not.is.null",
    ],
    conventions: [
      "netsuite_internal_id is the shared key between agents. Match on it first, always.",
      "Re-sending an identical payload is safe: documents dedupe on content hash, grades overwrite deterministically.",
      "Every bulk grade write snapshots prior values into score_snapshots under its label, so it can be undone.",
      "Push extracted TEXT, never PDF binaries — free-tier Supabase is 500MB and the PDF corpus is ~15GB.",
    ],
  });
}
