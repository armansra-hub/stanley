import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { deriveParticipantEvents } from "./metrics";
import { recordPublicGrowthTrigger, stableHash } from "./storage";
import { form5500IdentitySupported, isForm5500IdentityInput } from "./form5500Identity";
import { FORM5500_HISTORY_MAX_ROWS, form5500EvidenceForWrite, form5500ObservationExclusion } from "./form5500ObservationSafety";
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

export function crossYearEvents(row: Form5500ObservationInput, history: { active_participants_eoy?: number | null; form_year?: number | null }[]): DerivedGrowthEvent[] {
  // A prior observation is not necessarily the prior year: archives can omit
  // years and contain multiple filings/amendments for one plan year. Require
  // exactly one observation for each year used; do not choose an amendment by
  // database order or describe a multi-year gap as one year's growth.
  const previousRows = history.filter((observation) => observation.form_year === row.formYear - 1);
  if (previousRows.length !== 1) return [];
  const previous = previousRows[0];
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
  const twoYearsBackRows = history.filter((observation) => observation.form_year === row.formYear - 2);
  const twoYearsBack = Number(twoYearsBackRows.length === 1 ? twoYearsBackRows[0].active_participants_eoy ?? 0 : 0), priorGrowth = pct(twoYearsBack, before);
  if (growth != null && growth >= 25 && priorGrowth != null && priorGrowth >= 25) out.push({ family: "employee_growth", type: "employee_consecutive_growth", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:consecutive-growth`, strength: 92, summary: `Active benefit-plan participants grew at least 25% in each of 2 consecutive years, ending ${date} (${twoYearsBack.toLocaleString("en-US")} → ${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_growth", comparison: "two_consecutive_years", timeframeYears: 2, periodEnd: date, twoYearsBack, before, after, priorGrowthPct: priorGrowth, growthPct: growth } });
  if (growth != null && growth <= -25) out.push({ family: "employee_growth", type: "employee_decline", dedupeKey: `5500:${row.sponsorEin ?? row.sponsorName}:${row.planNumber}:year:${row.formYear}:decline25`, strength: 45, summary: `Active benefit-plan participants declined ${Math.abs(Math.round(growth))}% over 1 year, ending ${date} (${before.toLocaleString("en-US")} → ${after.toLocaleString("en-US")}).`, signalDate: date, metadata: { metric: "active_plan_participant_growth", comparison: "year_over_year", timeframeYears: 1, periodEnd: date, growthPct: growth, before, after } });
  return out;
}

export async function ingestForm5500Observations(rows: Form5500ObservationInput[]) {
  const candidates = rows.filter(isForm5500IdentityInput);
  if (!candidates.length) return { received: rows.length, stored: 0, rejected: rows.length, triggers: 0, companies: 0 };
  const db = serviceClient();
  const companyIds = [...new Set(candidates.map((r) => r.companyId))];
  const { data: allowed, error: allowedError } = await db.from("companies").select("id,name,state,city").in("id", companyIds).contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam");
  if (allowedError) throw new Error(`TAM validation failed: ${allowedError.message}`);
  const byId = new Map((allowed ?? []).map((company) => [String(company.id), company]));
  let stored = 0, triggers = 0, rejected = rows.length - candidates.length;
  const touched = new Set<string>();
  for (const row of candidates) {
    const company = byId.get(row.companyId);
    if (!company || !form5500IdentitySupported(company, row)) { rejected++; continue; }
    if (form5500ObservationExclusion(company.state, { sponsor_state: row.sponsorState, evidence: row.evidence })) { rejected++; continue; }
    const { data: existing, error: existingError } = await db.from("form5500_headcount_observations")
      .select("id,evidence,sponsor_state").eq("company_id", row.companyId).eq("filing_id", row.filingId).maybeSingle();
    if (existingError) throw new Error(`Form 5500 existing observation read failed: ${existingError.message}`);
    // A newly supported input cannot erase an existing reviewed hold or publish
    // signals from that held filing. Reversal is a separate reviewed operation.
    if (existing && form5500ObservationExclusion(company.state, existing)) { rejected++; continue; }
    let previousQuery = db.from("form5500_headcount_observations").select("id,active_participants_eoy,form_year,sponsor_state,evidence")
      .eq("company_id", row.companyId).eq("plan_number", row.planNumber).in("form_year", [row.formYear - 1, row.formYear - 2]);
    if (row.sponsorEin) previousQuery = previousQuery.eq("sponsor_ein", row.sponsorEin);
    // Filtering a three-row prefix could hide later valid duplicates. Read a
    // bounded complete scope and refuse truncation before deriving any events.
    const { data: history, error: historyError } = await previousQuery.order("form_year", { ascending: false }).order("id", { ascending: true }).limit(FORM5500_HISTORY_MAX_ROWS + 1);
    if (historyError) throw new Error(`Form 5500 adjacent-year history read failed: ${historyError.message}`);
    if ((history?.length ?? 0) > FORM5500_HISTORY_MAX_ROWS) throw new Error("Form 5500 adjacent-year history exceeds bounded complete-read limit");
    const eligibleHistory = (history ?? []).filter((prior) => !form5500ObservationExclusion(company.state, prior));
    const payload = { company_id: row.companyId, filing_id: row.filingId, form_type: row.formType, sponsor_ein: row.sponsorEin ?? null, sponsor_name: row.sponsorName, sponsor_dba: row.sponsorDba ?? null, sponsor_city: row.sponsorCity ?? null, sponsor_state: row.sponsorState ?? null, sponsor_zip: row.sponsorZip ?? null, plan_number: row.planNumber, plan_name: row.planName ?? null, form_year: row.formYear, plan_year_begin: row.planYearBegin ?? null, plan_year_end: row.planYearEnd ?? null, active_participants_boy: row.activeParticipantsBoy ?? null, active_participants_eoy: row.activeParticipantsEoy ?? null, match_method: row.matchMethod, match_confidence: row.matchConfidence, source_url: row.sourceUrl, payload_hash: stableHash(row), evidence: form5500EvidenceForWrite(existing?.evidence, row.evidence) };
    // Do not use upsert: it can clear a concurrent quarantine. Existing rows use
    // an evidence compare-and-set; a concurrent insert fails the unique key.
    const write = existing
      ? db.from("form5500_headcount_observations").update(payload).eq("id", existing.id)
        .eq("evidence", JSON.stringify(existing.evidence)).select("id").maybeSingle()
      : db.from("form5500_headcount_observations").insert(payload).select("id").single();
    const { data: written, error } = await write;
    if (error) throw new Error(`Form 5500 observation write failed: ${error.message}`);
    if (!written) throw new Error("Form 5500 observation changed concurrently; no events published");
    stored++; touched.add(row.companyId);
    const boy = Number(row.activeParticipantsBoy ?? 0), eoy = Number(row.activeParticipantsEoy ?? 0);
    const events = [...(boy >= 0 && eoy > 0 ? deriveParticipantEvents({ filingId: row.filingId, formYear: row.formYear, boy, eoy, signalDate: row.planYearEnd }) : []), ...crossYearEvents(row, eligibleHistory)];
    for (const event of events) if (await recordPublicGrowthTrigger(row.companyId, event, "DOL Form 5500", row.sourceUrl, row.matchConfidence)) triggers++;
  }
  for (const id of touched) await recomputePriority(id);
  return { received: rows.length, stored, rejected, triggers, companies: touched.size };
}
