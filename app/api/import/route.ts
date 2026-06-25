import { NextRequest, NextResponse } from "next/server";
import { ingestCandidates } from "@/lib/ingest/orchestrator";
import { fetchNewsForCompany } from "@/lib/sources/googleNews";
import { createImportBatch, setImportBatchEnriched, getCompaniesByBatch } from "@/lib/db/companies";
import type { Candidate } from "@/lib/ingest/types";
import type { ImportRow } from "@/lib/csv";

// CSV-upload mode: enrich each row with FREE signals (news now; EDGAR/ATS next),
// add as source='imported', and return an immediate report. Imported companies
// are kept even if out-of-territory (they're a watchlist), and every future
// refresh re-checks them (new signals light up the dot).
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 25; // cap per import to stay within the function time budget

export async function POST(req: NextRequest) {
  let body: { filename?: string; rows?: ImportRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const rows = (body?.rows ?? []).filter((r) => r && r.name);
  if (rows.length === 0) {
    return NextResponse.json({ error: "no rows with a company name" }, { status: 400 });
  }

  const filename = body.filename ?? "upload.csv";
  const capped = rows.slice(0, MAX_ROWS);
  const batchId = await createImportBatch(filename, rows.length);

  const candidates: Candidate[] = [];
  for (const r of capped) {
    const signals = await fetchNewsForCompany(r.name, 2);
    candidates.push({
      name: r.name,
      website: r.website || undefined,
      source: "imported",
      sources: ["csv_import"],
      signals,
    });
  }

  const result = await ingestCandidates(candidates, { importBatchId: batchId });
  await setImportBatchEnriched(batchId, result.upserted);
  const companies = await getCompaniesByBatch(batchId);

  return NextResponse.json({
    batch_id: batchId,
    filename,
    row_count: rows.length,
    truncated: rows.length > MAX_ROWS,
    ...result,
    processed: capped.length,
    companies,
  });
}
