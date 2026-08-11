import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { isReadableTable, readableTables, safeScalarSelect } from "@/lib/agent/readSelect";

/**
 * Read access to Stanley's data for the agents — allowlisted business tables,
 * allowlisted scalar columns, scalar PostgREST filters, and one token.
 *
 * WHY THIS EXISTS INSTEAD OF SHARING THE DATABASE KEY: the obvious way to let Codex
 * "see everything" is to hand it SUPABASE_SERVICE_ROLE_KEY. That key bypasses RLS
 * and grants full WRITE and DELETE on every table — it could empty all 15,257
 * companies — and once a secret leaves, rotation is the only way back. This route
 * gives broad business visibility with a credential that can only read: the service
 * key stays on the server, and tables and scalar columns are explicit allowlists.
 *
 * GET /api/agent/read?table=companies&select=name,tam_score&tam_score=gte.40&order=tam_score.desc&limit=50
 *
 * Scalar PostgREST filters work normally. Select relationship embeds, aliases,
 * spreads, casts, JSON paths, and computed expressions are deliberately rejected.
 */
export const dynamic = "force-dynamic";

/** Anything holding credentials, TAM coordination claims/seeds, or Arman's
 * personal calendar is deliberately absent. */
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
      readable: [...readableTables()].sort(),
      example: "/api/agent/read?table=companies&select=name,tam_score,codex_score&tam_score=gte.40&order=tam_score.desc&limit=25",
    }, { status: 400 });
  }
  if (!isReadableTable(table)) {
    return NextResponse.json({ error: `table '${table}' is not readable`, readable: [...readableTables()].sort() }, { status: 403 });
  }

  const selects = url.searchParams.getAll("select");
  if (selects.length > 1) {
    return NextResponse.json({ error: "select may be supplied at most once" }, { status: 400 });
  }
  const safeSelect = safeScalarSelect(table, selects[0] ?? null);
  if (!safeSelect.ok) return NextResponse.json({ error: safeSelect.error }, { status: 400 });

  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return NextResponse.json({ error: "supabase env missing" }, { status: 500 });

  const forwarded = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (OWN_PARAMS.has(k) || k === "limit") continue;
    forwarded.append(k, v);
  }
  forwarded.set("select", safeSelect.select);
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
  // content-range is "0-24/6949" — the total is what tells a caller whether to page.
  const total = res.headers.get("content-range")?.split("/")?.[1] ?? null;
  return NextResponse.json({ table, count: Array.isArray(rows) ? rows.length : 0, total, rows });
}
