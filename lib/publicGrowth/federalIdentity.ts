import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { normalizeName } from "./identity";

export interface VerifiedFederalIdentity {
  entityId: string;
  legalName: string;
  dbaName: string | null;
  uei: string | null;
  recipientId: string | null;
}

export interface FederalSearchTarget {
  query: string;
  identity: VerifiedFederalIdentity | null;
}

const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const identifier = (value: unknown) => text(value)?.toUpperCase() ?? null;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Existing verified relationships are the authority; names only retrieve candidates. */
export async function loadVerifiedFederalIdentities(companyId: string): Promise<VerifiedFederalIdentity[]> {
  const { data, error } = await serviceClient().from("company_government_matches")
    .select("government_entity_id,government_entities!inner(legal_name,dba_name,uei,usaspending_recipient_id)")
    .eq("company_id", companyId).eq("match_status", "verified").limit(101);
  if (error) throw new Error("verified federal identity load failed");
  if (!Array.isArray(data) || data.length > 100) throw new Error("verified federal identity set is incomplete");
  const identities = data.map((row) => {
    const entity = row.government_entities as unknown as Record<string, unknown>;
    if (!entity || !UUID.test(row.government_entity_id) || !text(entity.legal_name)
        || (!text(entity.uei) && !text(entity.usaspending_recipient_id))) throw new Error("invalid verified federal identity");
    return { entityId: row.government_entity_id, legalName: text(entity.legal_name)!, dbaName: text(entity.dba_name),
      uei: identifier(entity.uei), recipientId: text(entity.usaspending_recipient_id) };
  }).sort((a, b) => a.entityId.localeCompare(b.entityId));
  if (new Set(identities.map((row) => row.entityId)).size !== identities.length) throw new Error("duplicate verified federal identity");
  return identities;
}

export function federalSearchTargets(companyName: string, identities: VerifiedFederalIdentity[]): FederalSearchTarget[] {
  if (!identities.length) return [{ query: companyName, identity: null }];
  return identities.flatMap((identity) => [...new Set([identity.uei, identity.legalName, identity.dbaName].filter((v): v is string => Boolean(v)))]
    .map((query) => ({ query, identity: { ...identity } })));
}

/** Never accept one matching identifier when another present identifier conflicts. */
export function matchesFederalIdentifiers(frozen: Pick<VerifiedFederalIdentity, "uei" | "recipientId">,
  candidate: { uei: string | null; recipientId: string | null }): boolean {
  const uei = identifier(candidate.uei), expectedUei = identifier(frozen.uei);
  const recipient = text(candidate.recipientId), expectedRecipient = text(frozen.recipientId);
  if (expectedUei && uei && expectedUei !== uei) return false;
  if (expectedRecipient && recipient && expectedRecipient !== recipient) return false;
  return Boolean((expectedUei && uei === expectedUei) || (expectedRecipient && recipient === expectedRecipient));
}

export function targetAcceptsSearchRow(target: FederalSearchTarget, row: { recipientName: string; recipientUei: string | null }): boolean {
  if (target.identity) {
    // Older awards sometimes omit UEI in search but provide a recipient ID in detail.
    return !row.recipientUei || !target.identity.uei || identifier(row.recipientUei) === target.identity.uei;
  }
  return normalizeName(row.recipientName) === normalizeName(target.query);
}

export function assertFrozenFederalIdentities(frozen: VerifiedFederalIdentity[], current: VerifiedFederalIdentity[]): void {
  for (const identity of frozen) {
    const live = current.find((row) => row.entityId === identity.entityId);
    if (!live || live.uei !== identity.uei || live.recipientId !== identity.recipientId) throw new Error("frozen verified federal identity changed");
  }
}
