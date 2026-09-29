import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

export type RegistryFact = { field: string; label: string; value: string | number | boolean; unit?: string };
export type RegistryProfile = {
  version: 1; dataset: string; recordId: string; displayLabel?: string;
  sourceAsOf: string | null; observedAt: string; facts: RegistryFact[];
  identity: { legalName: string; addressLine1: string; addressLine2?: string; city?: string; state: string; postalCode: string; countryCode?: "US" | "CA" };
  provenance: { rowSha256: string; quote: string; sourceRow: Record<string, string | number | boolean | null>; localFile?: string };
  verification?: { method: "exact_legal_name_address" | "prior_registry_binding"; verifiedAt: string; sourceIds: string[] };
  publication?: { contentHash: string; eventId: string; publishedAt: string };
};

const DATASETS: Record<string, readonly string[]> = {
  fmcsa: ["data.transportation.gov", "safer.fmcsa.dot.gov", "ai.fmcsa.dot.gov"],
  tx_surveying: ["pels.texas.gov", "tbpedownloads.s3-us-west-2.amazonaws.com"],
  tx_engineering: ["pels.texas.gov", "tbpedownloads.s3-us-west-2.amazonaws.com"],
  wa_contractors: ["data.wa.gov", "lni.wa.gov"], ca_contractors: ["cslb.ca.gov", "web.cslb.ca.gov"],
  irs_exempt: ["irs.gov", "www.irs.gov"], sba_7a: ["data.sba.gov", "sba.gov"], sba_504: ["data.sba.gov", "sba.gov"],
  sec_adv: ["sec.gov", "www.sec.gov", "data.sec.gov"], sec_edgar: ["sec.gov", "www.sec.gov", "data.sec.gov"],
  co_sos: ["data.colorado.gov", "sos.state.co.us"], co_ucc: ["data.colorado.gov", "sos.state.co.us"],
  inc5000: ["inc.com", "www.inc.com"], cms_nppes: ["download.cms.gov", "npiregistry.cms.hhs.gov"],
  bc_orgbook: ["orgbook.gov.bc.ca"], ca_corporations: ["www.ic.gc.ca", "d4bf66bykfyaf.cloudfront.net"],
  cra_charities: ["open.canada.ca"],
};
const FACTS: Record<string, { label: string; unit?: string }> = {
  drivers: { label: "Reported drivers", unit: "drivers" }, power_units: { label: "Reported power units", unit: "power units" },
  usdot_number: { label: "USDOT number" }, carrier_operation: { label: "Carrier operation" }, operating_status: { label: "Operating status" },
  license_number: { label: "Firm license number" }, license_status: { label: "License status" }, license_type: { label: "License type" },
  licensed_professionals: { label: "Reported licensed professionals", unit: "licensed professionals" },
  license_issue_date: { label: "License issue date" }, license_expiry_date: { label: "License expiry date" },
  license_effective_date: { label: "License effective date" },
  business_number: { label: "Business registry number" }, tax_period: { label: "Financial reporting period" },
  legal_structure: { label: "Legal structure" }, tax_status: { label: "Tax-exempt status" }, ein: { label: "Organization EIN" },
  total_assets: { label: "Reported total assets", unit: "USD" }, total_revenue: { label: "Reported total revenue", unit: "USD" },
  total_expenses: { label: "Reported total expenses", unit: "USD" }, approval_amount: { label: "Approved loan amount", unit: "USD" },
  total_assets_cad: { label: "Reported total assets", unit: "CAD" }, total_revenue_cad: { label: "Reported total revenue", unit: "CAD" },
  total_expenses_cad: { label: "Reported total expenses", unit: "CAD" },
  approval_date: { label: "Loan approval date" }, jobs_supported: { label: "Reported jobs supported", unit: "jobs" },
  naics_code: { label: "NAICS code" }, assets_under_management: { label: "Regulatory assets under management", unit: "USD" },
  firm_employees: { label: "Reported firm employees", unit: "employees" }, advisory_clients: { label: "Reported advisory clients", unit: "clients" },
  filing_type: { label: "Filing type" }, filing_date: { label: "Filing date" }, formation_date: { label: "Formation date" },
  entity_status: { label: "Entity status" }, lien_type: { label: "UCC filing type" }, growth_percent: { label: "Reported growth", unit: "%" },
  rank: { label: "Published rank" }, npi: { label: "Organization NPI" }, organization_type: { label: "NPI entity type" },
  taxonomy: { label: "Organization taxonomy" }, registration_number: { label: "Registry number" },
};
const FIELDS: Record<string, string[]> = {
  fmcsa: ["drivers", "power_units", "usdot_number", "carrier_operation", "operating_status"],
  tx_surveying: ["license_number", "license_status", "license_type", "legal_structure", "licensed_professionals", "license_issue_date", "license_expiry_date"],
  tx_engineering: ["license_number", "license_status", "license_type", "legal_structure", "licensed_professionals", "license_issue_date", "license_expiry_date"],
  wa_contractors: ["license_number", "license_status", "license_type", "legal_structure", "registration_number", "business_number", "license_issue_date", "license_expiry_date", "license_effective_date"],
  ca_contractors: ["license_number", "license_status", "license_type", "legal_structure", "license_issue_date", "license_expiry_date"],
  irs_exempt: ["ein", "tax_status", "total_assets", "total_revenue", "total_expenses", "tax_period"],
  sba_7a: ["approval_amount", "approval_date", "jobs_supported", "naics_code", "legal_structure"],
  sba_504: ["approval_amount", "approval_date", "jobs_supported", "naics_code", "legal_structure"],
  sec_adv: ["assets_under_management", "firm_employees", "advisory_clients", "registration_number", "filing_date"],
  sec_edgar: ["filing_type", "filing_date", "registration_number", "total_assets", "total_revenue"],
  co_sos: ["formation_date", "entity_status", "legal_structure", "registration_number"],
  co_ucc: ["filing_date", "lien_type", "registration_number"], inc5000: ["growth_percent", "rank", "total_revenue"],
  cms_nppes: ["npi", "organization_type", "taxonomy"],
  bc_orgbook: ["business_number", "registration_number", "entity_status", "legal_structure", "formation_date"],
  ca_corporations: ["business_number", "registration_number", "entity_status", "legal_structure", "formation_date"],
  cra_charities: ["business_number", "registration_number", "tax_status", "tax_period", "total_assets_cad", "total_revenue_cad", "total_expenses_cad"],
};
const identityKeys = ["legalName", "addressLine1", "addressLine2", "city", "state", "postalCode", "countryCode"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const text = (v: unknown, n: number): v is string => typeof v === "string" && v.length > 0 && v.length <= n && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export function stableRegistryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableRegistryJson).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableRegistryJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function registryContentHash(profile: RegistryProfile, sourceUrl: string, detail: string | null = null): string {
  // Retrieval timestamps and server receipts do not manufacture new facts.
  const { verification: _verification, publication: _publication, observedAt: _observedAt, ...facts } = profile;
  return createHash("sha256").update(stableRegistryJson({ ...facts, sourceUrl, detail })).digest("hex");
}
export function registryProfileKey(profile: Pick<RegistryProfile, "dataset" | "recordId">): string {
  return `registry:${profile.dataset}:${profile.recordId}`;
}
export type RegistryFinding = { internalId: string; companyId: string; label: string; detail: string | null; evidence: string; sourceUrl: string; profile: RegistryProfile };

/** Closed public-field catalog. The caller supplies evidence, never a trusted identity decision. */
export function parseRegistryFinding(input: unknown, now = new Date()): RegistryFinding {
  if (!object(input) || input.source !== "registry" || input.kind !== "ops_profile") throw new Error("registry requires source=registry and kind=ops_profile");
  const p = input.registryProfile;
  if (!object(p) || p.version !== 1 || typeof p.dataset !== "string" || !DATASETS[p.dataset]) throw new Error("unsupported registry dataset/version");
  if (!text(input.internalId, 30) || !/^\d+$/.test(input.internalId) || !text(input.companyId, 36) || !UUID.test(input.companyId)) throw new Error("registry requires exact companyId and internalId");
  if (!text(p.recordId, 160) || !/^[A-Za-z0-9_.*:/-]+$/.test(p.recordId)) throw new Error("invalid registry recordId");
  if (p.verification !== undefined || p.publication !== undefined) throw new Error("registry verification and publication are server-owned");
  if (!text(input.sourceUrl, 2000)) throw new Error("invalid registry source URL");
  let url: URL;
  try { url = new URL(String(input.sourceUrl)); } catch { throw new Error("invalid registry source URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !DATASETS[p.dataset].includes(url.hostname)) throw new Error("registry source URL is not an approved dataset host");
  if (!(p.sourceAsOf === null || date(p.sourceAsOf)) || typeof p.observedAt !== "string" || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(p.observedAt)
    || !Number.isFinite(Date.parse(p.observedAt)) || Date.parse(p.observedAt) > now.getTime() + 60_000
    || p.sourceAsOf !== null && Date.parse(p.sourceAsOf) > now.getTime()) throw new Error("invalid registry source/retrieval date");
  if (!object(p.identity) || !object(p.provenance) || !object(p.provenance.sourceRow)) throw new Error("registry identity and source row are required");
  const identity = p.identity, provenance = p.provenance, sourceRow = p.provenance.sourceRow as Record<string, unknown>;
  for (const key of identityKeys) {
    const required = !["city", "addressLine2", "countryCode"].includes(key);
    if ((required || identity[key] !== undefined) && (!text(identity[key], 200) || sourceRow[key] !== identity[key])) throw new Error(`registry identity ${key} must match source row`);
  }
  const canadian = identity.countryCode === "CA";
  if (identity.countryCode !== undefined && !["US", "CA"].includes(String(identity.countryCode))
    || Object.keys(identity).some(k => !identityKeys.includes(k)) || !/^[A-Z]{2}$/.test(String(identity.state))
    || !(canadian ? /^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(String(identity.postalCode)) : /^\d{5}(?:-?\d{4})?$/.test(String(identity.postalCode)))) throw new Error("invalid registry country/postal identity fields");
  if (!text(input.evidence, 6000) || input.evidence.length < 10 || provenance.quote !== input.evidence
    || typeof provenance.rowSha256 !== "string" || !/^[a-f0-9]{64}$/.test(provenance.rowSha256)) throw new Error("registry requires exact unclipped quote and retained row SHA256");
  if (provenance.localFile !== undefined && !text(provenance.localFile, 500)) throw new Error("invalid registry local receipt locator");
  if (p.displayLabel !== undefined && !text(p.displayLabel, 160)) throw new Error("invalid registry display label");
  if (input.detail !== undefined && input.detail !== null && !text(input.detail, 1500)) throw new Error("invalid registry detail");
  if (!Array.isArray(p.facts) || p.facts.length < 1 || p.facts.length > 20) throw new Error("registry facts must contain 1–20 public fields");
  if (Object.keys(sourceRow).some(k => !identityKeys.includes(k) && !FIELDS[p.dataset as string].includes(k))) throw new Error("registry source row contains an unsupported/publicly unnecessary field");
  const seen = new Set<string>();
  const facts = p.facts.map(raw => {
    if (!object(raw) || typeof raw.field !== "string" || !FIELDS[p.dataset as string].includes(raw.field) || seen.has(raw.field)) throw new Error("unsupported or duplicate registry fact");
    seen.add(raw.field);
    if (!(text(raw.value, 500) || typeof raw.value === "boolean" || typeof raw.value === "number" && Number.isFinite(raw.value) && raw.value >= 0)
      || sourceRow[raw.field] !== raw.value) throw new Error("registry fact must equal its source-row value");
    const spec = FACTS[raw.field];
    if (raw.label !== undefined && raw.label !== spec.label || raw.unit !== undefined && raw.unit !== spec.unit) throw new Error("registry fact label/unit misrepresents the source metric");
    return { field: raw.field, ...spec, value: raw.value as string | number | boolean };
  });
  for (const value of Object.values(sourceRow)) {
    if (!(value === null || text(value, 500) || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value))) throw new Error("invalid registry source-row scalar");
    if (value !== null && !input.evidence.includes(String(value))) throw new Error("registry source-row values must occur in the retained exact quote");
  }
  if (p.dataset === "cms_nppes" && ![2, "2"].includes(sourceRow.organization_type as string | number)) throw new Error("CMS NPPES profiles require an organization (entity type 2)");
  const profile: RegistryProfile = { version: 1, dataset: p.dataset, recordId: p.recordId, ...(p.displayLabel ? { displayLabel: String(p.displayLabel) } : {}), sourceAsOf: p.sourceAsOf as string | null, observedAt: p.observedAt,
    facts, identity: identity as RegistryProfile["identity"], provenance: { rowSha256: provenance.rowSha256, quote: input.evidence, sourceRow: sourceRow as RegistryProfile["provenance"]["sourceRow"], ...(provenance.localFile ? { localFile: String(provenance.localFile) } : {}) } };
  return { internalId: input.internalId, companyId: input.companyId, label: registryProfileKey(profile), detail: input.detail ? String(input.detail) : null, evidence: input.evidence, sourceUrl: url.toString(), profile };
}

// Deliberately conservative: punctuation/spacing are normalized, legal suffixes,
// street numbers and unit designators are not discarded to manufacture a match.
const normalized = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const street = (v: string) => normalized(v).replace(/\b(street|avenue|road|boulevard|drive|lane|court|suite)\b/g, v => ({ street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct", suite: "ste" })[v]!);
const postal = (v: string, country?: string) => country === "CA" ? v.toUpperCase().replace(/\s/g, "") : v.slice(0, 5);
export function verifyRegistryIdentity(profile: RegistryProfile, company: { name: string }, context: CompanyIdentityContext, prior: RegistryProfile[], now = new Date()): RegistryProfile["verification"] | null {
  const p = profile.identity;
  const names = [company.name, ...context.aliases].map(normalized);
  const address = context.addresses.find(a => names.includes(normalized(p.legalName)) && street(a.addressLine1) === street(p.addressLine1)
    && street(a.addressLine2 ?? "") === street(p.addressLine2 ?? "") && normalized(a.state ?? "") === normalized(p.state)
    && (!a.countryCode || a.countryCode === (p.countryCode ?? "US"))
    && postal(a.postalCode ?? "", p.countryCode) === postal(p.postalCode, p.countryCode) && (!p.city || !a.city || normalized(p.city) === normalized(a.city)));
  if (address) return { method: "exact_legal_name_address", verifiedAt: now.toISOString(), sourceIds: [address.sourceId] };
  const binding = prior.find(old => old.dataset === profile.dataset && old.recordId === profile.recordId && old.publication?.contentHash
    && old.verification?.sourceIds.length && ["exact_legal_name_address", "prior_registry_binding"].includes(old.verification.method)
    && stableRegistryJson(old.identity) === stableRegistryJson(profile.identity));
  return binding ? { method: "prior_registry_binding", verifiedAt: now.toISOString(), sourceIds: [...binding.verification!.sourceIds] } : null;
}
