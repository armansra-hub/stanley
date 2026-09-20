import "server-only";
import { createHash } from "node:crypto";
import { serviceClient } from "@/lib/supabase/server";
import { enqueueObservation } from "@/lib/intelligence/observations";
import { evaluateNativeCached, type NativeJevInput } from "@/lib/intelligence/nativeJev";
import { recordPublicGrowthTrigger } from "./storage";
import { recomputePriority } from "@/lib/db/triggers";

type Company = { id: string; name: string; domain: string | null; netsuite_internal_id?: string | null };
export type ContractAward = { id: string; generated_award_id: string; government_entity_id: string; award_id: string | null;
  awarding_agency: string | null; description: string | null; start_date: string | null; end_date: string | null;
  potential_end_date: string | null; naics_code?: string | null; psc_code?: string | null; award_type?: string | null;
  award_ceiling: number | null; current_award_amount: number | null; total_obligations: number | null;
  source_url: string; evidence?: Record<string, unknown> | null; payload_hash: string };
export type ContractMilestone = { kind: "start" | "end" | "potential_end" | "ordering_end" | "option"; date: string; stage: number; label: string; sourceUrl?:string };
const DAY = 86_400_000;
const isoDate = (value: unknown): string | null => {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)||!Number.isFinite(Date.parse(value)))return null;
  const date=value.slice(0,10);return new Date(`${date}T00:00:00Z`).toISOString().slice(0,10)===date?date:null;
};
const publicUrl=(value:unknown):value is string=>{try{const url=new URL(String(value));return ["http:","https:"].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}};
const excerpt=(text:unknown,bytes:number)=>{const value=typeof text==="string"?text:"";let end=Math.min(value.length,bytes);while(Buffer.byteLength(value.slice(0,end))>bytes)end--;if(/[\uD800-\uDBFF]/.test(value[end-1]))end--;return value.slice(0,end);};
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function checked<T>(query: PromiseLike<{ data: T; error: unknown }>): Promise<T> {
  const result = await query; if (result.error) throw new Error("contract_intelligence_persistence_failed"); return result.data;
}

/** Dates are facts from the source, not predictions of renewal or an ERP need. */
export function contractMilestones(award: ContractAward, now = Date.now()): ContractMilestone[] {
  const evidence = award.evidence ?? {};
  const facts: Array<[ContractMilestone["kind"], unknown, string, string?]> = [
    ["start", award.start_date, "Performance starts"], ["end", award.end_date, "Current performance ends"],
    ["potential_end", award.potential_end_date, "Potential end if options apply"],
    ["ordering_end", evidence.orderingEndDate, "Ordering period ends"],
  ];
  // No invented option schedule. Only individually sourced dates qualify.
  for (const option of Array.isArray(evidence.optionDates) ? evidence.optionDates : []) {
    if (option && typeof option === "object" && publicUrl(option.sourceUrl)) facts.push(["option", option.date, "Reported option window",option.sourceUrl]);
  }
  const today = Date.parse(new Date(now).toISOString().slice(0, 10));
  return facts.flatMap(([kind, raw, label,sourceUrl]) => {
    const date = isoDate(raw); if (!date) return [];
    if (kind === "potential_end" && date === isoDate(award.end_date)) return [];
    const days = Math.round((Date.parse(date) - today) / DAY);
    if (days < 0 || days > 180) return [];
    const stage = days <= 7 ? 7 : days <= 30 ? 30 : days <= 90 ? 90 : 180;
    return [{ kind, date, stage, label,...(sourceUrl?{sourceUrl}:{}) }];
  });
}

/** Fully sourced structured context goes to the normal native Jev interpretation
 * and research path once per material award version. No second grader. */
export function contractObservation(company: Company, award: ContractAward, recipient: string) {
  const facts = { recipient, awardIdentifier: award.award_id, generatedAwardId: award.generated_award_id,
    awardType: award.award_type, agency: award.awarding_agency, description: award.description,
    naics: award.naics_code, productServiceCode: award.psc_code, performanceStart: award.start_date,
    currentPerformanceEnd: award.end_date, potentialEnd: award.potential_end_date,
    ceilingIncludingOptions: award.award_ceiling, currentAwardAmount: award.current_award_amount,
    obligationsCommitted: award.total_obligations, sourceDetails: award.evidence };
  return { companyId: company.id, companyName: company.name, companyDomain: company.domain,
    netsuiteInternalId: company.netsuite_internal_id, sourceKind: "government" as const, sourceUrl: award.source_url,
    title: `${recipient}: ${award.awarding_agency ?? "government"} contract ${award.award_id ?? award.generated_award_id}`,
    text: `Official award record. The recipient has a separately sourced verified identity binding to this account.\n${JSON.stringify(facts, null, 2)}\nInterpret the actual work described: staffing/payroll, project costing, time and expense, unbilled work, milestone or reimbursable billing, multi-location service delivery, subcontractor management, controls and reporting. A classification code alone does not prove a company uses a specific system or has pain. A ceiling is maximum potential authority, obligations are commitments, neither is recognized revenue. A vehicle award does not prove task-order revenue. Missing option dates remain unknown.`,
    eventDate: isoDate(award.evidence?.signedDate) ?? isoDate(award.start_date),
    metadata: { structuredAward: true, federalAwardId: award.id, generatedAwardId: award.generated_award_id,
      recipientIdentity: "verified_direct", sourceAuthority: "USAspending", questionContext: "business-services-contract-work-v1" } };
}

type Announcement = { id: string; summary: string; source_url: string; signal_date: string | null; metadata: Record<string, unknown> };
function announcementText(row: Announcement): string {
  const source = row.metadata?.intelligenceEvidence as { excerpt?: unknown } | undefined;
  return `${row.summary}\n${typeof source?.excerpt === "string" ? source.excerpt : ""}`;
}
export function exactAnnouncementAward(row: Announcement, award: ContractAward): boolean {
  const id = award.award_id?.trim();
  if (!id || id.replace(/[^a-z0-9]/gi, "").length < 8) return false;
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(announcementText(row));
}
export function announcementLinkInput(company: string, announcement: Announcement, awards: ContractAward[]): NativeJevInput {
  return { state: { company, announcement: { title: announcement.summary, date: announcement.signal_date, url: announcement.source_url,
    passage: excerpt(announcementText(announcement),3200) }, officialAwards: awards.map(a => ({ id: a.id, identifier: a.award_id,
      agency: excerpt(a.awarding_agency,500), description: excerpt(a.description,3000), start: a.start_date, signed: a.evidence?.signedDate,
      ceiling: a.award_ceiling, obligations: a.total_obligations, source: a.source_url })) }, questions: {
    award: { type: "choice", instructions: "Link this early government award announcement to its later official record, only when the same recipient, agency, work/project and timing identify the same award. This is source correspondence, not a review of the prior Jev answer or a legal-entity decision. All candidate recipient identities are already directly bound to this account. Different orders under one vehicle, amendments, solicitations and merely similar work are distinct. Money may be a ceiling versus funded obligations; do not require them to equal. Choose none when ambiguous or no match.",
      criteria: { none: "No unique corresponding official record", ...Object.fromEntries(awards.map(a => [a.id, `Official award ${a.award_id ?? a.generated_award_id}`])) } },
  } };
}

async function reconcileAnnouncements(company: Company, _awards: ContractAward[], deadline: number): Promise<number> {
  const db = serviceClient();
  const rows = await checked(db.from("triggers").select("id,summary,source_url,signal_date,metadata")
    .eq("company_id", company.id).eq("type", "government_announcement").is("metadata->officialAward", null)
    .gte("signal_date", new Date(Date.now() - 180 * DAY).toISOString()).order("detected_at", { ascending: false }).limit(20)) as Announcement[];
  if (!rows?.length) return 0;
  const bindings = await checked(db.from("company_government_matches").select("government_entity_id").eq("company_id", company.id).eq("match_status", "verified"));
  const entityIds = (bindings ?? []).map(row => row.government_entity_id);
  if (!entityIds.length) return 0;
  const awards: ContractAward[] = [];
  for (let offset = 0; ; offset += 500) {
    if (Date.now() >= deadline - 35_000) return 0;
    const page = await checked(db.from("federal_awards").select("*").in("government_entity_id", entityIds)
      .order("id").range(offset, offset + 499)) as ContractAward[];
    awards.push(...page);
    if (page.length < 500) break;
  }
  let linked = 0;
  for (const row of rows ?? []) {
    if (Date.now() >= deadline - 32_000) break;
    const date = Date.parse(row.signal_date ?? "");
    const candidates = awards.filter(a => exactAnnouncementAward(row, a) || Number.isFinite(date)
      && Math.abs(Date.parse(String(a.evidence?.signedDate ?? a.start_date ?? "")) - date) <= 120 * DAY);
    const exact = candidates.filter(a => exactAnnouncementAward(row, a));
    let selected: ContractAward | null = exact.length === 1 ? exact[0] : null;
    const nativeReceipts: unknown[] = [];
    const selectedIds = new Set<string>();
    let fullyCompared = true;
    for (let start = 0; !selected && start < candidates.length; start += 6) {
      if (Date.now() >= deadline - 32_000) { fullyCompared = false; break; }
      const batch = candidates.slice(start, start + 6);
      const result = await evaluateNativeCached(announcementLinkInput(company.name, row, batch), {
        purpose: "event_match", companyId: company.id, sourceKind: "award_correspondence", workload: "monitoring" });
      if (result.status !== "complete" || !result.evaluation.ok) { fullyCompared = false; break; }
      nativeReceipts.push(result.evaluation.provider_result);
      const choice = result.evaluation.provider_result.answers.award.choice;
      if (batch.some(a => a.id === choice)) selectedIds.add(choice!);
    }
    // An ambiguous match across batches stays an announcement. Cached original
    // choices resume comparison without a second charge or a second opinion.
    if (!fullyCompared) continue;
    selected ??= selectedIds.size === 1 ? candidates.find(a => selectedIds.has(a.id)) ?? null : null;
    if (!selected) continue;
    const saved = await db.rpc("contract_announcement_link", { p_company: company.id, p_trigger: row.id, p_award: selected.id,
      p_method: nativeReceipts.length ? "jev_source_correspondence" : "exact_award_identifier", p_native: nativeReceipts.length ? nativeReceipts : null });
    if (saved.error || saved.data !== true) throw new Error("contract_announcement_link_failed");
    linked++;
  }
  return linked;
}

/** One leased account at a time. No offset cap, so small accounts cannot starve
 * large ones; award delivery checkpoints and timing receipts survive restarts. */
export async function runContractIntelligence(limit = 5, deadline = Date.now() + 160_000) {
  const db = serviceClient(); let checkedAccounts = 0, observations = 0, milestones = 0, links = 0;
  for (let i = 0; i < limit && Date.now() < deadline - 35_000; i++) {
    const claim = await db.rpc("contract_intelligence_claim");
    if (claim.error) throw new Error("contract_intelligence_claim_failed");
    if (!claim.data) break;
    const { company, lease_token: lease, awards, recipients } = claim.data as {
      company: Company; lease_token: string; awards: ContractAward[]; recipients: Record<string, string> };
    try {
      for (const award of awards) {
        if (Date.now() >= deadline - 35_000) break;
        const prepared = contractObservation(company, award, recipients[award.government_entity_id] ?? company.name);
        const deliveryKey = hash([company.id, award.id, prepared.text, prepared.eventDate, "contract-work-v1"]);
        const prior = await checked(db.from("contract_intelligence_deliveries").select("delivery_key").eq("delivery_key", deliveryKey).maybeSingle());
        if (!prior) {
          const observation = await enqueueObservation(prepared);
          if (observation) {
            await checked(db.from("contract_intelligence_deliveries").upsert({ delivery_key: deliveryKey, company_id: company.id,
              federal_award_id: award.id, observation_id: observation.id }, { onConflict: "delivery_key" }).select("delivery_key"));
            observations++;
          }
        }
        for (const milestone of contractMilestones(award)) {
          const dedupe = `contract:${award.id}:${milestone.kind}:${milestone.date}:${milestone.stage}`;
          const receipt = await checked(db.from("contract_milestones").upsert({ company_id: company.id, federal_award_id: award.id,
            kind: milestone.kind, milestone_date: milestone.date, label: milestone.label, source_url: milestone.sourceUrl??award.source_url,
            evidence: { awardIdentifier: award.award_id, dateKind: milestone.kind, optionSchedule: award.evidence?.optionSchedule ?? "not_provided_by_source" } },
            { onConflict: "company_id,federal_award_id,kind,milestone_date" }).select("id").single());
          if (!receipt) throw new Error("contract_milestone_receipt_missing");
          const inserted = await recordPublicGrowthTrigger(company.id, { type: "contract_timing", family: "federal_contract",
            dedupeKey: dedupe, strength: 70, signalDate: new Date().toISOString().slice(0, 10),
            summary: `${milestone.label} ${milestone.date} · ${award.awarding_agency ?? "Government"} · ${award.award_id ?? "contract"}`,
            metadata: { milestoneId: receipt.id, federalAwardId: award.id, generatedAwardId: award.generated_award_id,
              milestoneDate: milestone.date, milestoneKind: milestone.kind, reminderWindowDays: milestone.stage,
              milestoneSourceUrl: milestone.sourceUrl??award.source_url,
              factNotPrediction: true } }, "USAspending · known contract date", milestone.sourceUrl??award.source_url);
          if (inserted) milestones++;
        }
        const timing = await db.rpc("contract_timing_sync", {p_company:company.id,p_lease:lease,p_award:award.id});
        if(timing.error||timing.data!==true)throw new Error("contract_timing_sync_failed");
        const ack = await db.rpc("contract_intelligence_award_done", { p_company: company.id, p_lease: lease, p_award: award.id });
        if (ack.error || ack.data !== true) throw new Error("contract_intelligence_progress_failed");
      }
      links += await reconcileAnnouncements(company, awards, deadline);
      await recomputePriority(company.id);
      const finish = await db.rpc("contract_intelligence_finish", { p_company: company.id, p_lease: lease, p_error: null });
      if (finish.error || finish.data !== true) throw new Error("contract_intelligence_checkpoint_failed");
      checkedAccounts++;
    } catch {
      await db.rpc("contract_intelligence_finish", { p_company: company.id, p_lease: lease, p_error: "contract_processing_failed" });
    }
  }
  return { checkedAccounts, observations, milestones, links };
}
