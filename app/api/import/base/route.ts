import { NextRequest, NextResponse } from "next/server";
import { bulkImportBase, createImportBatch } from "@/lib/db/companies";
import { logEvent } from "@/lib/db/events";
import type { BaseRow } from "@/lib/csv";
import type { LeadVendor } from "@/lib/baseImport";

/**
 * TAM Base bulk import. Body: { vendor, filename, rows: BaseRow[] }. Fast,
 * deterministic, deduped, block-enforced — no per-row enrichment. The client
 * parses the CSV and chunks large files; we cap per request as a guard.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VENDORS = new Set(["zoominfo", "linkedin", "netsuite"]);
const MAX_ROWS = 3000; // per request; the client chunks bigger files

const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export async function POST(req: NextRequest) {
  let body: { vendor?: string; filename?: string; list?: string; rows?: BaseRow[]; batchId?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }

  const vendor = (body.vendor ?? "").toLowerCase();
  if (!VENDORS.has(vendor)) return NextResponse.json({ error: "vendor must be zoominfo | linkedin | netsuite" }, { status: 400 });
  // Silo/list key — each named CSV is its own list. Default to "<vendor>_tam".
  const listKey = slug(body.list || `${vendor}_tam`);
  const rows = (body.rows ?? []).filter((r) => r && r.name);
  if (rows.length === 0) return NextResponse.json({ error: "no rows with a company name" }, { status: 400 });
  if (rows.length > MAX_ROWS) return NextResponse.json({ error: `too many rows (${rows.length}); chunk to ${MAX_ROWS}` }, { status: 413 });

  try {
    // One batch per logical upload; the client passes batchId on follow-up chunks.
    const batchId = body.batchId ?? (await createImportBatch(`${listKey}:${body.filename ?? "base.csv"}`, rows.length));
    const report = await bulkImportBase(rows, vendor as LeadVendor, listKey, batchId);
    await logEvent("headhunter", "base.imported", {
      summary: `${listKey}: ${report.imported} new + ${report.updated} updated (${report.blocked} blocked)`,
      entity_type: "import", meta: { vendor, list: listKey, ...report },
    });
    return NextResponse.json({ batchId, vendor, list: listKey, ...report });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
