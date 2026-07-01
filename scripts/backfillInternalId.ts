/**
 * One-off backfill: re-run the NetSuite TAM CSV through the live /api/import/base
 * route so the previously-imported base rows get their `netsuite_internal_id`
 * populated. Uses the app's own parser (lib/csv) so the domain keying is identical
 * to the original import — additive, idempotent, NetSuite-as-truth.
 *
 *   npx tsx scripts/backfillInternalId.ts
 */
import { readFileSync } from "node:fs";
import { parseCsv, rowsToBaseRows } from "../lib/csv";

const FILE = "/Users/armansra/Desktop/NETSUITE TAM.csv";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const VENDOR = "netsuite";
const LIST = "netsuite_tam";
const CHUNK = 3000;

async function main() {
  const text = readFileSync(FILE, "utf-8");
  const grid = parseCsv(text);
  const rows = rowsToBaseRows(grid);
  const withId = rows.filter((r) => r.internal_id).length;
  console.log(`Parsed ${rows.length} rows · ${withId} carry an Internal ID`);
  if (rows.length === 0) throw new Error("no rows parsed");

  let batchId: string | null = null;
  const tot: Record<string, number> = { total: 0, imported: 0, updated: 0, blocked: 0, no_domain: 0 };
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res: Response = await fetch(`${BASE}/api/import/base`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vendor: VENDOR, list: LIST, filename: "NETSUITE TAM.csv", rows: slice, batchId }),
    });
    const r: Record<string, number> & { error?: string; batchId?: string | null } = await res.json();
    if (!res.ok) throw new Error(`chunk ${i}: ${r.error ?? res.status}`);
    batchId = r.batchId ?? batchId;
    for (const k of Object.keys(tot)) tot[k] += (r[k] as number) ?? 0;
    console.log(`  chunk ${i}-${i + slice.length}: +${r.imported} new, ${r.updated} merged, ${r.blocked} blocked`);
  }
  console.log(`DONE — ${tot.imported} new · ${tot.updated} merged · ${tot.blocked} blocked · ${tot.no_domain} no-domain`);
}

main().catch((e) => { console.error(e); process.exit(1); });
