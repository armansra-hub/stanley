import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { deriveRevenueEvents } from "./metrics";
import { recordPublicGrowthTriggersBulk, stableHash } from "./storage";

const PRIORITY_RECOMPUTE_CONCURRENCY = 10;
const DATABASE_PAGE_SIZE = 1000;
const WRITE_BATCH_SIZE = 500;

export function parseRevenueEstimate(value: string | null | undefined): number | null {
  if (!value) return null;
  const numbers = [...value.replace(/,/g, "").matchAll(/\$?([0-9]+(?:\.[0-9]+)?)\s*([kmb])?/gi)].map((m) => {
    const n = Number(m[1]), unit = (m[2] ?? "").toLowerCase();
    return n * (unit === "b" ? 1e9 : unit === "m" ? 1e6 : unit === "k" ? 1e3 : 1);
  }).filter(Number.isFinite);
  if (!numbers.length) return null;
  // A band is not exact; its lower bound is the defensible threshold evidence.
  return Math.min(...numbers);
}

export async function sweepRevenueTamBatch(limit: number, offset: number) {
  const db = serviceClient(), observedOn = new Date().toISOString().slice(0, 10);
  const data: Array<{ id: string; name: string; revenue_band: string | null }> = [];
  while (data.length < limit) {
    const pageSize = Math.min(DATABASE_PAGE_SIZE, limit - data.length);
    const start = offset + data.length;
    const page = await db.from("companies").select("id,name,revenue_band").contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam").order("id").range(start, start + pageSize - 1);
    if (page.error) throw new Error(`revenue TAM load failed: ${page.error.message}`);
    const rows = (page.data ?? []) as Array<{ id: string; name: string; revenue_band: string | null }>;
    data.push(...rows);
    if (rows.length < pageSize) break;
  }
  const observations = [];
  const triggerRows: Parameters<typeof recordPublicGrowthTriggersBulk>[0] = [];
  for (const company of data) {
    const estimated = parseRevenueEstimate(company.revenue_band);
    if (estimated == null) continue;
    // NetSuite's revenue band is a standing snapshot, not a new growth event every
    // day. Keep observation rows dated, but use a stable milestone identity so a
    // later rotation cannot publish the same threshold again under a new date.
    const observationId = stableHash({ companyId: company.id, source: "netsuite_revenue_band", band: company.revenue_band }).slice(0, 24);
    observations.push({ company_id: company.id, source: "NetSuite TAM revenue band", observed_on: observedOn, estimated_revenue: estimated, revenue_band: company.revenue_band, source_url: null, payload_hash: stableHash({ band: company.revenue_band, estimated }), evidence: { estimateMethod: "revenue_band_lower_bound" } });
    for (const event of deriveRevenueEvents({ source: "NetSuite TAM revenue band", observationId, priorRevenue: null, currentRevenue: estimated, signalDate: observedOn })) triggerRows.push({ companyId: company.id, event, sourceName: "NetSuite TAM revenue estimate", sourceUrl: `https://system.netsuite.com/app/common/entity/custjob.nl?id=${encodeURIComponent(company.id)}&signal=${encodeURIComponent(event.type)}&threshold=${event.metadata.threshold}`, confidence: 0.7 });
  }
  for (let start = 0; start < observations.length; start += WRITE_BATCH_SIZE) {
    const { error: upsertError } = await db.from("company_revenue_observations").upsert(observations.slice(start, start + WRITE_BATCH_SIZE), { onConflict: "company_id,source,observed_on" });
    if (upsertError) throw new Error(`revenue observation bulk upsert failed: ${upsertError.message}`);
  }
  // The full 48-hour rotation revisits thousands of unchanged bands. Prefetch
  // their stable milestone keys in bounded company batches so the common daily
  // path does not issue one dedupe query and one priority write per company.
  const existing = new Set<string>();
  const candidateCompanyIds = [...new Set(triggerRows.map((row) => row.companyId))];
  for (let start = 0; start < candidateCompanyIds.length; start += 100) {
    const ids = candidateCompanyIds.slice(start, start + 100);
    const { data: prior, error: priorError } = await db.from("triggers").select("company_id,dedupe_key")
      .in("company_id", ids).eq("type", "revenue_milestone");
    if (priorError) throw new Error(`revenue milestone prefetch failed: ${priorError.message}`);
    for (const row of prior ?? []) existing.add(`${row.company_id}:${row.dedupe_key}`);
  }
  const pendingTriggerRows = triggerRows.filter((row) => !existing.has(`${row.companyId}:${row.event.dedupeKey}`));
  const triggers = await recordPublicGrowthTriggersBulk(pendingTriggerRows);
  const affectedCompanyIds = [...new Set(pendingTriggerRows.map((row) => row.companyId))];
  // Only new milestones need a priority refresh; unchanged daily observations
  // retain the priority computed when their trigger was first recorded.
  for (let start = 0; start < affectedCompanyIds.length; start += PRIORITY_RECOMPUTE_CONCURRENCY) {
    await Promise.all(affectedCompanyIds.slice(start, start + PRIORITY_RECOMPUTE_CONCURRENCY)
      .map((companyId) => recomputePriority(companyId)));
  }
  return {
    source: "revenue",
    offset,
    checked: data.length,
    nextOffset: offset + data.length,
    done: data.length < limit,
    observed: observations.length,
    triggers,
    prioritiesRecomputed: affectedCompanyIds.length,
  };
}
