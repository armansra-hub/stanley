import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import {
  ASSESSMENT_ARTIFACT_RULES,
  SCORE_KNOWN_HISTORY,
  SCORE_STORAGE_RULES,
} from "@/lib/agent/scoreContract";
import { verifyProductionSource } from "@/scripts/verify-production-source.mjs";

/**
 * Self-describing protocol for the agent bridge — one URL an agent can hit to
 * learn the whole interface plus the current state of the work, so neither side
 * has to guess at the other's schema. Also the fastest way to confirm a token works.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const db = serviceClient();
  const sourceAttestation = verifyProductionSource(process.env);

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
      "GET  /api/agent/read?table=companies&…": "Read allowlisted tables and scalar columns. Scalar PostgREST filters (eq/gt/like/in/or), order, and limit (max 1000) are supported; relationship embeds, aliases, spreads, casts, JSON paths, and computed selects are rejected. Call without ?table to list readable tables.",
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
    deploymentSource: {
      attested: sourceAttestation.ok && sourceAttestation.checked,
      checked: sourceAttestation.checked,
      reason: sourceAttestation.reason,
      received: "received" in sourceAttestation ? sourceAttestation.received : null,
      policySentinelConfigured: process.env.STANLEY_PRODUCTION_SOURCE_POLICY === "github-main-only-v1",
      releaseRule: "Production is valid only after exact Vercel readback confirms src=git, GitHub armansra-hub/stanley, main, and the intended immutable commit.",
    },
    scoring: {
      storageRules: SCORE_STORAGE_RULES,
      assessmentArtifactRules: ASSESSMENT_ARTIFACT_RULES,
    },
    knownHistory: SCORE_KNOWN_HISTORY,
    reading: [
      "You have READ access to explicitly allowlisted business tables and scalar columns via /api/agent/read — including companies, triggers, exports, app_events, and score_snapshots. Call it with no ?table to see the table list.",
      "The database key is deliberately NOT shared: /api/agent/read is GET-only over table and scalar-column allowlists, rejects relationship traversal, and cannot delete or overwrite anything.",
      "Examples: ?table=companies&tam_score=gte.40&order=tam_score.desc | ?table=triggers&type=in.(funding,ma)&order=detected_at.desc | ?table=companies&score_adjust_note=is.null&netsuite_internal_id=not.is.null",
    ],
    conventions: [
      "netsuite_internal_id is the shared key between agents. Match on it first, always.",
      "Re-sending an identical payload is safe: documents dedupe on content hash, grades overwrite deterministically.",
      "Every bulk grade write is one row-locked database transaction: all mutable fields are first preserved in score_snapshots.prior_values under the label, then all target rows are updated. Any validation, snapshot, or update failure rolls the whole batch back; restoration remains an explicit reviewed operation.",
      "Push extracted TEXT, never PDF binaries. The verified current PDF corpus is 1,728,918,143 bytes, above the 1GB Free Storage quota; binaries remain in the trusted local evidence corpus.",
    ],
  });
}
