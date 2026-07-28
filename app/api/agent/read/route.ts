import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";

/**
 * Read access to Stanley's data for the agents — every business table, the full
 * PostgREST filter language, one token.
 *
 * WHY THIS EXISTS INSTEAD OF SHARING THE DATABASE KEY: the obvious way to let Codex
 * "see everything" is to hand it SUPABASE_SERVICE_ROLE_KEY. That key bypasses RLS
 * and grants full WRITE and DELETE on every table — it could empty all 15,257
 * companies — and once a secret leaves, rotation is the only way back. This route
 * gives the same visibility with a credential that can only read: the service key
 * stays on the server, the method is GET-only, and the table list is an allowlist.
 *
 * GET /api/agent/read?table=companies&select=name,tam_score&tam_score=gte.40&order=tam_score.desc&limit=50
 *
 * Every PostgREST operator works: eq, neq, gt, gte, lt, lte, like, ilike, in, is,
 * not, or, and — e.g. `?table=triggers&type=in.(funding,ma)&order=detected_at.desc`.
 */
export const dynamic = "force-dynamic";

/** Business data: readable. Anything holding credentials or Arman's personal
 * calendar is deliberately absent — say the word and it can be added. */
const READABLE = new Set([
  "companies", "triggers", "signals", "exports", "app_events", "lead_documents",
  "lead_pool", "leads", "lead_notes", "lead_tasks", "missions", "pipeline_stages",
  "scoring_weights", "score_snapshots", "import_batches", "discovery_coverage",
  "fmcsa_snapshots", "agent_messages", "agent_tasks", "stanley_logs",
  "territory_config", "schema_migrations",
]);

const MAX_LIMIT = 1000;
/** Ours, not PostgREST's — must not be forwarded upstream. */
const OWN_PARAMS = new Set(["table", "token"]);

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();

  const url = new URL(req.url);
  const table = url.searchParams.get("table");
  if (!table) {
    return NextResponse.json({
      error: "table is required",
      readable: [...READABLE].sort(),
      example: "/api/agent/read?table=companies&select=name,tam_score,codex_score&tam_score=gte.40&order=tam_score.desc&limit=25",
    }, { status: 400 });
  }
  if (!READABLE.has(table)) {
    return NextResponse.json({ error: `table '${table}' is not readable`, readable: [...READABLE].sort() }, { status: 403 });
  }

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return NextResponse.json({ error: "supabase env missing" }, { status: 500 });

  const forwarded = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (OWN_PARAMS.has(k) || k === "limit") continue;
    forwarded.append(k, v);
  }
  if (!forwarded.has("select")) forwarded.set("select", "*");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, MAX_LIMIT);

  const upstream = `${base}/rest/v1/${table}?${forwarded.toString()}`;
  const res = await fetch(upstream, {
    method: "GET", // read-only by construction — no write verb is ever forwarded
    headers: { apikey: key, authorization: `Bearer ${key}`, prefer: "count=exact", range: `0-${limit - 1}` },
  });

  const text = await res.text();
  if (!res.ok) return NextResponse.json({ error: "query rejected", status: res.status, detail: text.slice(0, 600) }, { status: 400 });

  let rows: unknown = [];
  try { rows = JSON.parse(text); } catch { /* upstream returned non-JSON */ }
  // content-range is "0-24/7402" — the total is what tells a caller whether to page.
  const total = res.headers.get("content-range")?.split("/")?.[1] ?? null;
  return NextResponse.json({ table, count: Array.isArray(rows) ? rows.length : 0, total, rows });
}
