import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { samQueueHash, type SamQueuedNotice } from "./samOpportunitySource";

/** Revalidate only the exact facts used by a frozen candidate. Unrelated new
 * awards or other TAM identities cannot invalidate an already captured notice. */
export async function verifySamDeliveryRelationship(companyId: string, candidate: SamQueuedNotice["candidates"][number][1]): Promise<void> {
  const evidence = candidate.evidence;
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
  if (!uuid(evidence.verifiedMatchId) || !uuid(evidence.governmentEntityId)) throw new Error("SAM frozen candidate lacks its exact verified relationship");
  const db = serviceClient();
  const { data, error } = await db.from("company_government_matches")
    .select("id,company_id,government_entity_id,government_entities!inner(uei,legal_name,dba_name,city,state)")
    .eq("id", evidence.verifiedMatchId).eq("company_id", companyId).eq("government_entity_id", evidence.governmentEntityId)
    .eq("match_status", "verified").maybeSingle();
  if (error || !data || data.id !== evidence.verifiedMatchId || data.company_id !== companyId || data.government_entity_id !== evidence.governmentEntityId)
    throw new Error("SAM frozen candidate relationship is no longer verified");
  const entity = data.government_entities as unknown as { uei?: string | null; legal_name?: string | null; dba_name?: string | null; city?: string | null; state?: string | null };
  if (candidate.relationship === "incumbent_recompete" && evidence.method === "verified_incumbent_agency_naics_plus_office_or_psc") {
    const award = evidence.incumbentAward as Record<string, unknown> | undefined;
    if (!award || !uuid(award.id) || award.government_entity_id !== evidence.governmentEntityId) throw new Error("SAM incumbent lacks its exact frozen award evidence");
    const { data: current, error: awardError } = await db.from("federal_awards")
      .select("id,government_entity_id,awarding_agency,awarding_office,naics_code,psc_code")
      .eq("id", award.id).eq("government_entity_id", evidence.governmentEntityId).maybeSingle();
    if (awardError || !current || samQueueHash(current) !== samQueueHash(award)) throw new Error("SAM incumbent matching facts changed before delivery");
  } else if (candidate.relationship === "awardee" && evidence.method === "exact_awardee_uei") {
    if (!entity?.uei || String(entity.uei).toUpperCase() !== evidence.uei) throw new Error("SAM awardee UEI changed before delivery");
  } else if (candidate.relationship === "awardee" && evidence.method === "verified_legal_name_and_location") {
    const current = { legal_name: entity?.legal_name ?? null, dba_name: entity?.dba_name ?? null, city: entity?.city ?? null, state: entity?.state ?? null };
    if (!evidence.sourceIdentity || samQueueHash(current) !== samQueueHash(evidence.sourceIdentity)) throw new Error("SAM awardee name or location changed before delivery");
  } else throw new Error("Unsupported frozen SAM candidate relationship");
}
