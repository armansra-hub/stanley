import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";

/**
 * Everything Stanley knows about one lead, in a single call — the shape a grader
 * actually wants, instead of five round trips against /api/agent/read.
 *
 * GET /api/agent/lead?internalId=92847818
 * GET /api/agent/lead?name=Agenda            (fuzzy, returns the best matches)
 *
 * Returns each company row for that NetSuite internal ID (duplicates exist), plus
 * its live triggers with decay context, any pushed record text, the exports it has
 * appeared in, and the prior-score history from score_snapshots.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();

  const url = new URL(req.url);
  const internalId = url.searchParams.get("internalId");
  const name = url.searchParams.get("name");
  if (!internalId && !name) {
    return NextResponse.json({ error: "pass internalId or name" }, { status: 400 });
  }

  const db = serviceClient();
  const q = db.from("companies").select("*");
  const { data: companies, error } = internalId
    ? await q.eq("netsuite_internal_id", internalId)
    : await q.ilike("name", `%${name}%`).limit(10);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!companies?.length) return NextResponse.json({ found: 0, companies: [] });

  const ids = companies.map((c) => c.id as string);
  const nsids = [...new Set(companies.map((c) => String(c.netsuite_internal_id)).filter(Boolean))];

  const [triggers, docs, snapshots] = await Promise.all([
    db.from("triggers").select("*").in("company_id", ids).order("detected_at", { ascending: false }),
    nsids.length
      ? db.from("lead_documents").select("id, netsuite_internal_id, doc_type, source, title, captured_at, created_at, body").in("netsuite_internal_id", nsids)
      : Promise.resolve({ data: [] as unknown[] }),
    db.from("score_snapshots").select("*").in("company_id", ids).order("taken_at", { ascending: false }).limit(20),
  ]);

  return NextResponse.json({
    found: companies.length,
    companies,
    triggers: triggers.data ?? [],
    // Text can be very large; return a preview plus the id so the full body can be
    // fetched deliberately via /api/agent/documents?internalId=…
    documents: (docs.data ?? []).map((d) => {
      const doc = d as Record<string, unknown>;
      const body = String(doc.body ?? "");
      return { ...doc, body: undefined, chars: body.length, preview: body.slice(0, 500) };
    }),
    priorScores: snapshots.data ?? [],
  });
}
