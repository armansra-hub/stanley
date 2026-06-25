import { NextRequest, NextResponse } from "next/server";
import { ingestCandidates } from "@/lib/ingest/orchestrator";
import type { Candidate } from "@/lib/ingest/types";

// Generic "growth list" import (e.g., Inc. 5000): each row becomes a DISCOVERED
// candidate with a list-membership signal citing the list URL. Out-of-territory
// rows are dropped by the gate (that's the point — intersect the list with the
// territory). Rows carry websites where the CSV has them, so they get real
// domains (SQL-exportable).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 40;

export async function POST(req: NextRequest) {
  let body: {
    rows?: { name: string; website?: string; state?: string }[];
    source_id?: string;
    list_name?: string;
    list_url?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const rows = (body?.rows ?? []).filter((r) => r && r.name);
  if (rows.length === 0) {
    return NextResponse.json({ error: "no rows with a company name" }, { status: 400 });
  }
  const sourceId = body.source_id || "inc5000";
  const listName = body.list_name || "Inc. 5000";
  const listUrl = body.list_url || "https://www.inc.com/inc5000";

  const candidates: Candidate[] = rows.slice(0, MAX_ROWS).map((r) => ({
    name: r.name,
    website: r.website || undefined,
    state: r.state || null,
    source: "discovered",
    sources: [sourceId],
    signals: [
      {
        source_name: listName,
        source_url: listUrl,
        raw_excerpt: `${r.name} was named to the ${listName} list of fastest-growing companies${r.state ? ` (${r.state})` : ""}.`,
      },
    ],
  }));

  const result = await ingestCandidates(candidates);
  return NextResponse.json({ list: listName, ...result, processed: candidates.length });
}
