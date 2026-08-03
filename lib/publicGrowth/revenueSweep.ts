import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { deriveRevenueEvents } from "./metrics";
import { recordPublicGrowthTrigger, stableHash } from "./storage";

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
  const { data, error } = await db.from("companies").select("id,name,revenue_band").contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam").order("id").range(offset, offset + limit - 1);
  if (error) throw new Error(`revenue TAM load failed: ${error.message}`);
  let observed = 0, triggers = 0;
  for (const company of data ?? []) {
    const estimated = parseRevenueEstimate(company.revenue_band);
    if (estimated == null) continue;
    const { data: prior } = await db.from("company_revenue_observations").select("estimated_revenue,observed_on").eq("company_id", company.id).eq("source", "NetSuite TAM revenue band").lt("observed_on", observedOn).order("observed_on", { ascending: false }).limit(1).maybeSingle();
    const observationId = stableHash({ companyId: company.id, observedOn, band: company.revenue_band }).slice(0, 24);
    const payload = { company_id: company.id, source: "NetSuite TAM revenue band", observed_on: observedOn, estimated_revenue: estimated, revenue_band: company.revenue_band, source_url: null, payload_hash: stableHash({ band: company.revenue_band, estimated }), evidence: { estimateMethod: "revenue_band_lower_bound" } };
    const { error: upsertError } = await db.from("company_revenue_observations").upsert(payload, { onConflict: "company_id,source,observed_on" });
    if (upsertError) throw new Error(`revenue observation upsert failed: ${upsertError.message}`);
    observed++;
    for (const event of deriveRevenueEvents({ source: "NetSuite TAM revenue band", observationId, priorRevenue: prior?.estimated_revenue == null ? null : Number(prior.estimated_revenue), currentRevenue: estimated, signalDate: observedOn })) {
      if (await recordPublicGrowthTrigger(company.id, event, "NetSuite TAM revenue estimate", `https://system.netsuite.com/app/common/entity/custjob.nl?id=${encodeURIComponent(company.id)}&signal=${encodeURIComponent(event.type)}&threshold=${event.metadata.threshold}`, 0.7)) triggers++;
    }
    await recomputePriority(company.id);
  }
  return { source: "revenue", offset, checked: data?.length ?? 0, nextOffset: offset + (data?.length ?? 0), done: (data?.length ?? 0) < limit, observed, triggers };
}
