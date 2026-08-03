import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { deriveParticipantEvents } from "./metrics";
import { recordPublicGrowthTrigger, stableHash } from "./storage";
import type { DerivedGrowthEvent } from "./types";

export interface Form5500ObservationInput {
  companyId: string;
  filingId: string;
  formType: string;
  sponsorEin?: string | null;
  sponsorName: string;
  sponsorDba?: string | null;
  sponsorCity?: string | null;
  sponsorState?: string | null;
  sponsorZip?: string | null;
  planNumber: string;
  planName?: string | null;
  formYear: number;
  planYearBegin?: string | null;
  planYearEnd?: string | null;
  activeParticipantsBoy?: number | null;
  activeParticipantsEoy?: number | null;
  matchMethod: string;
  matchConfidence: number;
  sourceUrl: string;
  evidence?: Record<string, unknown>;
}

const pct = (a: number, b: number) => a > 0 ? ((b - a) / a) * 100 : null;

function crossYearEvents(row: Form5500ObservationInput, history: { active_participants_eoy?: number | null; form_year?: number | null }[]): DerivedGrowthEvent[] {
  const previous = history[0] ?? null;
  const before = Number(previous?.active_participants_eoy ?? 0), after = Number(row.activeParticipantsEoy ?? 0);
  if (!previous || before <= 0 || after <= 0) return [];
  const date = row.planYearEnd ?? `${row.formYear}-12-31`, out: DerivedGrowthEvent[] = [];
  for (const threshold of [50, 100, 250, 500, 1000]) {
    if (before < threshold && after >= threshold) out.push({ family: "employee_growth", type: "employee_milestone", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:participants:${threshold}`, strength: Math.min(92, 60 + Math.log10(threshold) * 10), summary: `Active benefit-plan participants passed ${threshold.toLocaleString("en-US")} over 1 year, by ${date} (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participants", comparison: "year_over_year", timeframeYears: 1, threshold, before, after, previousFormYear: previous.form_year, formYear: row.formYear, thresholdPassedBy: date } });
  }
  const growth = pct(before, after);
  if (growth != null && growth > 0) for (const threshold of [25, 50, 100]) {
    if (growth >= threshold) out.push({ family: "employee_growth", type: "employee_growth", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:growth:${threshold}`, strength: Math.min(94, 62 + threshold / 4), summary: `Active benefit-plan participants grew ${Math.round(growth)}% over 1 year, ending ${date} (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_growth", comparison: "year_over_year", timeframeYears: 1, thresholdPct: threshold, growthPct: growth, before, after, previousFormYear: previous.form_year, formYear: row.formYear, periodEnd: date } });
  }
  const delta = after - before;
  if (delta > 0) for (const threshold of [25, 50, 100, 250, 500]) {
    if (delta >= threshold) out.push({ family: "employee_growth", type: "employee_absolute_growth", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:added:${threshold}`, strength: Math.min(91, 58 + Math.log10(threshold) * 12), summary: `Active benefit-plan participants increased by ${delta.toLocaleString("en-US")} over 1 year, ending ${date} (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_absolute_growth", timeframeYears: 1, periodEnd: date, threshold, delta, before, after } });
  }
  const twoYearsBack = Number(history[1]?.active_participants_eoy ?? 0), priorGrowth = pct(twoYearsBack, before);
  if (growth != null && growth >= 25 && priorGrowth != null && priorGrowth >= 25) out.push({ family: "employee_growth", type: "employee_consecutive_growth", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:consecutive-growth`, strength: 92, summary: `Active benefit-plan participants grew at least 25% in each of 2 consecutive years, ending ${date} (${twoYearsBack.toLocaleString("en-US")} → ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_growth", comparison: "two_consecutive_years", timeframeYears: 2, periodEnd: date, twoYearsBack, before, after, priorGrowthPct: priorGrowth, growthPct: growth } });
  if (growth != null && growth <= -25) out.push({ family: "employee_growth", type: "employee_decline", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:decline25`, strength: 45, summary: `Active benefit-plan participants declined ${Math.abs(Math.round(growth))}% over 1 year, ending ${date} (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_growth", comparison: "year_over_year", timeframeYears: 1, periodEnd: date, growthPct: growth, before, after } });
  return out;
}

export async function ingestForm5500Observations(rows: Form5500ObservationInput[]) {
  const db = serviceClient();
  const companyIds = [...new Set(rows.map((r) => r.companyId))];
  const { data: allowed, error: allowedError } = await db.from("companies").select("id").in("id", companyIds).contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam");
  if (allowedError) throw new Error(`TAM validation failed: ${allowedError.message}`);
  const allow = new Set((allowed ?? []).map((x) => String(x.id)));
  let stored = 0, triggers = 0, rejected = 0;
  const touched = new Set<string>();
  for (const row of rows) {
    if (!allow.has(row.companyId)) { rejected++; continue; }
    let previousQuery = db.from("form5500_headcount_observations").select("active_participants_eoy,form_year")
      .eq("company_id", row.companyId).eq("plan_number", row.planNumber).lt("form_year", row.formYear);
    if (row.sponsorEin) previousQuery = previousQuery.eq("sponsor_ein", row.sponsorEin);
    const { data: history } = await previousQuery.order("form_year", { ascending: false }).limit(2);
    const payload = { company_id: row.companyId, filing_id: row.filingId, form_type: row.formType, sponsor_ein: row.sponsorEin ?? null, sponsor_name: row.sponsorName, sponsor_dba: row.sponsorDba ?? null, sponsor_city: row.sponsorCity ?? null, sponsor_state: row.sponsorState ?? null, sponsor_zip: row.sponsorZip ?? null, plan_number: row.planNumber, plan_name: row.planName ?? null, form_year: row.formYear, plan_year_begin: row.planYearBegin ?? null, plan_year_end: row.planYearEnd ?? null, active_participants_boy: row.activeParticipantsBoy ?? null, active_participants_eoy: row.activeParticipantsEoy ?? null, match_method: row.matchMethod, match_confidence: row.matchConfidence, source_url: row.sourceUrl, payload_hash: stableHash(row), evidence: row.evidence ?? {} };
    const { error } = await db.from("form5500_headcount_observations").upsert(payload, { onConflict: "company_id,filing_id" });
    if (error) throw new Error(`Form 5500 observation upsert failed: ${error.message}`);
    stored++; touched.add(row.companyId);
    const boy = Number(row.activeParticipantsBoy ?? 0), eoy = Number(row.activeParticipantsEoy ?? 0);
    const events = [...(boy >= 0 && eoy > 0 ? deriveParticipantEvents({ filingId: row.filingId, formYear: row.formYear, boy, eoy, signalDate: row.planYearEnd }) : []), ...crossYearEvents(row, history ?? [])];
    for (const event of events) if (await recordPublicGrowthTrigger(row.companyId, event, "DOL Form 5500", row.sourceUrl, row.matchConfidence)) triggers++;
  }
  for (const id of touched) await recomputePriority(id);
  return { received: rows.length, stored, rejected, triggers, companies: touched.size };
}
