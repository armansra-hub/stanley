import "server-only";
import { isIP } from "node:net";
import { serviceClient } from "@/lib/supabase/server";
import legacyData from "./customerReferenceData.json";
import { customerReferenceCatalogSources, type CustomerReferenceSeed, type CustomerReferenceSource } from "./customerReferenceSources";

export type ReferenceAnnouncement = { id: string; date: string; type: CustomerReferenceSeed["announcementType"]; sourceUrl?: string; sourceMessageId?: string };
export type CustomerReferenceRegistryRow = {
  id: string; name: string; domain: string | null; website: string | null;
  announcement_date: string; announcement_type: CustomerReferenceSeed["announcementType"];
  buying_program_id: string | null; comparison_industry: string | null; identity_notes: string[];
  announcements?: ReferenceAnnouncement[]; announcement_count?: number; candidate_urls: string[];
  sources: (Omit<CustomerReferenceSource, "text"> & { text?: string })[];
  source_status: "pending" | "running" | "ready" | "blocked"; source_checkpoint: Record<string, unknown> | null;
  source_lease_token?: string | null; source_lease_until: string | null;
  active: boolean; as_of: string; created_at: string; updated_at: string;
  native_status?: string | null; native_catalog_version?: string | null; native_evidence_key?: string | null;
  native_answered?: number; native_last_error?: string | null; native_lease_until?: string | null; native_updated_at?: string | null;
};
export type CustomerReferenceProofSeed = Omit<CustomerReferenceSeed, "sources"> & { sources: CustomerReferenceRegistryRow["sources"] };
export type CustomerReferenceImport = {
  id: string; existingReferenceId?: string; name: string; domain: string | null; website: string | null;
  announcementDate: string; announcementType: CustomerReferenceSeed["announcementType"]; asOf: string;
  announcements: ReferenceAnnouncement[]; candidateUrls: string[]; buyingProgramId?: string; comparisonIndustry?: string; identityNotes: string[];
};
export type StoredCustomerReference = { id: string; catalog_version: string; evidence_key: string; status: string; result: unknown };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const announcementTypes = new Set(["new_customer", "expansion", "renewal", "unknown"]);
const idOk = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.-]{1,120}$/.test(v);
const text = (v: unknown, max: number) => typeof v === "string" && v.trim().length > 0 && v.length <= max ? v.trim() : null;
function date(v: unknown): v is string {
  return typeof v === "string" && /^20\d{2}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v))
    && new Date(v).toISOString().slice(0, 10) === v && v >= "2024-01-01" && v <= new Date().toISOString().slice(0, 10);
}
export function customerReferencePublicUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || (url.port && !["80", "443"].includes(url.port))
      || isIP(host) || !host.includes(".") || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return null;
    url.hash = ""; return url.toString();
  } catch { return null; }
}
export function normalizeCustomerReferenceImport(body: Record<string, unknown>): CustomerReferenceImport[] {
  if (Object.keys(body).some(key => key !== "records") || !Array.isArray(body.records) || !body.records.length || body.records.length > 100) throw new Error("invalid_registry_import");
  const seen = new Set<string>();
  return body.records.map((value, index) => {
    const fail = (): never => { throw new Error(`invalid_registry_record:${index}`); };
    if (!record(value) || !idOk(value.id) || !text(value.name, 300) || !date(value.announcementDate) || !date(value.asOf)
      || !announcementTypes.has(String(value.announcementType)) || !Array.isArray(value.announcements) || !value.announcements.length
      || value.announcements.length > 1000 || !Array.isArray(value.candidateUrls) || value.candidateUrls.length > 100
      || (value.existingReferenceId !== undefined && !idOk(value.existingReferenceId))) return fail();
    const target = value.existingReferenceId ?? value.id;
    if (typeof target !== "string" || seen.has(target)) return fail(); seen.add(target);
    const domain = value.domain == null ? null : text(value.domain, 253)?.toLowerCase().replace(/^www\./, "") ?? fail();
    if (domain && (!/^[a-z0-9.-]+$/.test(domain) || !customerReferencePublicUrl(`https://${domain}`))) return fail();
    const website = value.website == null ? null : customerReferencePublicUrl(value.website) ?? fail();
    if (website && (!domain || new URL(website).hostname.toLowerCase().replace(/^www\./, "") !== domain)) return fail();
    const candidateUrls = [...new Set(value.candidateUrls.map(url => customerReferencePublicUrl(url) ?? fail()))];
    const announcements = value.announcements.map((a): ReferenceAnnouncement => {
      if (!record(a) || !text(a.id, 250) || !date(a.date) || !announcementTypes.has(String(a.type))) return fail();
      const sourceUrl = a.sourceUrl == null ? undefined : customerReferencePublicUrl(a.sourceUrl) ?? fail();
      const sourceMessageId = a.sourceMessageId == null ? undefined : text(a.sourceMessageId, 250) ?? fail();
      return { id: String(a.id), date: a.date, type: a.type as ReferenceAnnouncement["type"], ...(sourceUrl ? { sourceUrl } : {}), ...(sourceMessageId ? { sourceMessageId } : {}) };
    });
    if (new Set(announcements.map(a => a.id)).size !== announcements.length) return fail();
    const identityNotes = value.identityNotes === undefined ? [] : Array.isArray(value.identityNotes) && value.identityNotes.length <= 30
      ? value.identityNotes.map(note => text(note, 1000) ?? fail()) : fail();
    const optional = (key: string, max: number) => value[key] == null ? undefined : text(value[key], max) ?? fail();
    return { id: value.id, ...(value.existingReferenceId ? { existingReferenceId: String(value.existingReferenceId) } : {}),
      name: String(value.name).trim(), domain, website, announcementDate: value.announcementDate,
      announcementType: value.announcementType as CustomerReferenceImport["announcementType"], asOf: value.asOf,
      announcements, candidateUrls, identityNotes, buyingProgramId: optional("buyingProgramId", 120), comparisonIndustry: optional("comparisonIndustry", 150) };
  });
}

let legacyAdmission: Promise<void> | undefined;
/** Reuse the already-paid cohort once; ignore-duplicate admission never resets
 * packets, checkpoints, native results, source leases or imported provenance. */
export function ensureCustomerReferenceRegistry(): Promise<void> {
  if (!legacyAdmission) legacyAdmission = (async () => {
    const db = serviceClient(), seeds = legacyData.references as CustomerReferenceSeed[];
    const present = await db.from("intelligence_customer_reference_registry").select("id").in("id", seeds.map(seed => seed.id));
    if (present.error) throw new Error("customer_registry_unavailable");
    const known = new Set((present.data ?? []).map(row => row.id));
    const missing = seeds.filter(seed => !known.has(seed.id));
    if (!missing.length) return;
    const admitted = await db.from("intelligence_customer_reference_registry").upsert(missing.map(seed => {
      customerReferenceCatalogSources(seed);
      return { id: seed.id, name: seed.name, domain: seed.domain, website: seed.website, announcement_date: seed.announcementDate,
        announcement_type: seed.announcementType, buying_program_id: seed.buyingProgramId ?? null, comparison_industry: seed.comparisonIndustry ?? null,
        identity_notes: seed.identityNotes ?? [], announcements: [], candidate_urls: [seed.website], sources: seed.sources,
        source_status: "ready", as_of: legacyData.asOf };
    }), { onConflict: "id", ignoreDuplicates: true });
    if (admitted.error) throw new Error("customer_registry_admission_failed");
  })().catch(error => { legacyAdmission = undefined; throw error; });
  return legacyAdmission;
}

export async function loadCustomerReferenceRegistry(options: { includeSources?: boolean } = {}): Promise<CustomerReferenceRegistryRow[]> {
  await ensureCustomerReferenceRegistry();
  const db = serviceClient(), rows: CustomerReferenceRegistryRow[] = [];
  let after: string | null = null;
  while (true) {
    const result = options.includeSources ? await (after
      ? db.from("intelligence_customer_reference_registry").select("*").eq("active", true).gt("id", after).order("id").limit(250)
      : db.from("intelligence_customer_reference_registry").select("*").eq("active", true).order("id").limit(250))
      : await db.rpc("intelligence_customer_reference_registry_page", { p_after: after, p_limit: 250 });
    if (result.error || !Array.isArray(result.data)) throw new Error("customer_registry_unavailable");
    const page = result.data as CustomerReferenceRegistryRow[];
    if (!page.length) break;
    rows.push(...page); const last = page[page.length - 1].id;
    if (after && last <= after) throw new Error("customer_registry_cursor_invalid");
    after = last; if (page.length < 250) break;
  }
  return rows;
}
export async function getCustomerReferenceRegistryRow(id: string): Promise<CustomerReferenceRegistryRow | null> {
  await ensureCustomerReferenceRegistry();
  const result = await serviceClient().from("intelligence_customer_reference_registry").select("*").eq("id", id).eq("active", true).maybeSingle();
  if (result.error) throw new Error("customer_registry_unavailable");
  return result.data as CustomerReferenceRegistryRow | null;
}
export function customerReferenceRegistryProofSeed(row: CustomerReferenceRegistryRow): CustomerReferenceProofSeed | null {
  if (!row.domain || !row.website || !row.sources.length) return null;
  return { id: row.id, name: row.name, domain: row.domain, website: row.website, announcementDate: row.announcement_date,
    announcementType: row.announcement_type, buyingProgramId: row.buying_program_id ?? undefined,
    comparisonIndustry: row.comparison_industry ?? undefined, identityNotes: row.identity_notes, sources: row.sources };
}
export function customerReferenceRegistrySeed(row: CustomerReferenceRegistryRow): CustomerReferenceSeed | null {
  const proof = customerReferenceRegistryProofSeed(row);
  if (!proof || proof.sources.some(source => typeof source.text !== "string")) return null;
  const seed = proof as CustomerReferenceSeed;
  try { customerReferenceCatalogSources(seed); return seed; } catch { return null; }
}
export async function loadCustomerReferenceMatchRows(): Promise<StoredCustomerReference[]> {
  await ensureCustomerReferenceRegistry();
  const db = serviceClient(), rows: StoredCustomerReference[] = [];
  let after: string | null = null;
  while (true) {
    const page = await db.rpc("intelligence_customer_reference_match_page", { p_after: after, p_limit: 100 });
    if (page.error || !Array.isArray(page.data)) throw new Error("customer_reference_results_unavailable");
    const data = page.data as StoredCustomerReference[];
    if (!data.length) break; rows.push(...data);
    const last = data[data.length - 1].id;
    if (after && last <= after) throw new Error("customer_reference_cursor_invalid");
    after = last; if (data.length < 100) break;
  }
  return rows;
}
export async function importCustomerReferenceRegistry(records: CustomerReferenceImport[]) {
  await ensureCustomerReferenceRegistry();
  const result = await serviceClient().rpc("intelligence_customer_reference_import", { p_records: records });
  if (result.error) throw new Error("customer_registry_import_failed");
  return result.data;
}
