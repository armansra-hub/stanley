import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import type { DerivedGrowthEvent } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export const stableHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function saveGovernmentEntity(entity: Record<string, any>): Promise<string> {
  const db = serviceClient();
  let existing: any = null;
  if (entity.uei) ({ data: existing } = await db.from("government_entities").select("id").eq("uei", entity.uei).maybeSingle());
  if (!existing && entity.usaspending_recipient_id) ({ data: existing } = await db.from("government_entities").select("id").eq("usaspending_recipient_id", entity.usaspending_recipient_id).maybeSingle());
  const payload = { ...entity, observed_at: new Date().toISOString(), payload_hash: stableHash(entity) };
  if (existing?.id) {
    const { error } = await db.from("government_entities").update(payload).eq("id", existing.id);
    if (error) throw new Error(`government entity update failed: ${error.message}`);
    return String(existing.id);
  }
  const { data, error } = await db.from("government_entities").insert(payload).select("id").single();
  if (error || !data) throw new Error(`government entity insert failed: ${error?.message}`);
  return String(data.id);
}

export async function saveCompanyGovernmentMatch(companyId: string, entityId: string, decision: { status: string; method: string; confidence: number; evidence: Record<string, unknown> }) {
  const db = serviceClient();
  const { error } = await db.from("company_government_matches").upsert({ company_id: companyId, government_entity_id: entityId, match_status: decision.status, match_method: decision.method, confidence: decision.confidence, evidence: decision.evidence, verified_by: decision.status === "verified" ? "deterministic" : null, verified_at: decision.status === "verified" ? new Date().toISOString() : null, updated_at: new Date().toISOString() }, { onConflict: "company_id,government_entity_id" });
  if (error) throw new Error(`government match upsert failed: ${error.message}`);
}

export async function saveFederalAward(entityId: string, award: Record<string, any>): Promise<string> {
  const db = serviceClient();
  const payload = { government_entity_id: entityId, generated_award_id: award.generatedAwardId, award_id: award.awardId, parent_award_id: award.parentAwardId, award_type: award.awardType, awarding_agency: award.awardingAgency, awarding_subagency: award.awardingSubagency, funding_agency: award.fundingAgency, funding_subagency: award.fundingSubagency, awarding_office: award.awardingOffice, naics_code: award.naicsCode, psc_code: award.pscCode, description: award.description, start_date: award.startDate, end_date: award.endDate, potential_end_date: award.potentialEndDate, award_ceiling: award.awardCeiling, current_award_amount: award.currentAwardAmount, total_obligations: award.totalObligations, source_url: award.sourceUrl, source_updated_at: award.sourceUpdatedAt, observed_at: new Date().toISOString(), payload_hash: stableHash(award), evidence: { solicitationIdentifier: award.solicitationIdentifier, offersReceived: award.offersReceived, extentCompeted: award.extentCompeted, setAside: award.setAside } };
  const { data, error } = await db.from("federal_awards").upsert(payload, { onConflict: "generated_award_id" }).select("id").single();
  if (error || !data) throw new Error(`federal award upsert failed: ${error?.message}`);
  return String(data.id);
}

export async function saveFederalTransactions(awardId: string, sourceUrl: string, rows: any[]): Promise<number> {
  if (!rows.length) return 0;
  const db = serviceClient();
  const payload = rows.map((t) => ({ federal_award_id: awardId, external_transaction_id: String(t.id), action_date: t.action_date, action_type: t.action_type_description ?? t.action_type ?? null, modification_number: t.modification_number ?? null, federal_action_obligation: Number(t.federal_action_obligation ?? 0), description: t.description ?? null, source_url: sourceUrl, payload_hash: stableHash(t), evidence: { type: t.type, typeDescription: t.type_description } }));
  const { error } = await db.from("federal_award_transactions").upsert(payload, { onConflict: "external_transaction_id" });
  if (error) throw new Error(`federal transaction upsert failed: ${error.message}`);
  return payload.length;
}

export async function saveSamOpportunity(row: Record<string, any>): Promise<string> {
  const db = serviceClient();
  const payload = { notice_id: row.noticeId, solicitation_number: row.solicitationNumber, award_number: row.awardNumber, notice_type: row.noticeType, status: row.status, title: row.title, description: row.description, agency: row.agency, subagency: row.subagency, office: row.office, naics_code: row.naicsCode, psc_code: row.pscCode, set_aside: row.setAside, posted_date: row.postedDate, response_deadline: row.responseDeadline, archive_date: row.archiveDate, place_of_performance: row.placeOfPerformance ?? {}, awardee_name: row.awardeeName, awardee_uei: row.awardeeUei, award_amount: row.awardAmount, source_url: row.sourceUrl, payload_hash: stableHash(row), evidence: row.evidence ?? {} };
  const { data, error } = await db.from("sam_opportunities").upsert(payload, { onConflict: "notice_id" }).select("id").single();
  if (error || !data) throw new Error(`SAM opportunity upsert failed: ${error?.message}`);
  return String(data.id);
}

export async function saveOpportunityMatch(companyId: string, opportunityId: string, relationship: string, confidence: number, evidence: Record<string, unknown>) {
  const { error } = await serviceClient().from("company_opportunity_matches").upsert({ company_id: companyId, opportunity_id: opportunityId, relationship, confidence, evidence, status: "active", updated_at: new Date().toISOString() }, { onConflict: "company_id,opportunity_id,relationship" });
  if (error) throw new Error(`opportunity match upsert failed: ${error.message}`);
}

export async function saveFederalSubaward(row: Record<string, any>): Promise<void> {
  const payload = { external_subaward_id: row.externalSubawardId, prime_award_generated_id: row.primeAwardGeneratedId ?? null, prime_government_entity_id: row.primeGovernmentEntityId ?? null, subaward_government_entity_id: row.subawardGovernmentEntityId ?? null, subawardee_name: row.subawardeeName, subaward_amount: row.amount, action_date: row.actionDate, description: row.description, awarding_agency: row.awardingAgency, source_url: row.sourceUrl, payload_hash: stableHash(row), evidence: row.evidence ?? {} };
  const { error } = await serviceClient().from("federal_subawards").upsert(payload, { onConflict: "external_subaward_id" });
  if (error) throw new Error(`federal subaward upsert failed: ${error.message}`);
}

export async function recordPublicGrowthTrigger(companyId: string, event: DerivedGrowthEvent, sourceName: string, sourceUrl: string, confidence = 1): Promise<boolean> {
  const db = serviceClient();
  const { data: prior } = await db.from("triggers").select("id").eq("company_id", companyId).eq("dedupe_key", event.dedupeKey).maybeSingle();
  if (prior) return false;
  // Migration 0017 also dedupes (company_id, source_url). A single filing or
  // contract can legitimately emit several distinct threshold events, so retain
  // the human source while giving each derived event its own stable fragment.
  const uniqueSourceUrl = `${sourceUrl}${sourceUrl.includes("#") ? "&" : "#"}stanley-signal=${encodeURIComponent(event.dedupeKey)}`;
  const { error } = await db.from("triggers").insert({ company_id: companyId, type: event.type, family: event.family, strength: Math.round(event.strength), half_life_days: event.family === "employee_growth" || event.family === "revenue_growth" ? 730 : 180, summary: event.summary.slice(0, 280), source_name: sourceName, source_url: uniqueSourceUrl, signal_date: event.signalDate, confidence, dedupe_key: event.dedupeKey, metadata: event.metadata });
  if (error) {
    if (error.code === "23505") return false;
    throw new Error(`public growth trigger insert failed: ${error.message}`);
  }
  return true;
}
