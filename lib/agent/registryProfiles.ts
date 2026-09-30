import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";

export type RegistryFact = { field: string; label: string; value: string | number | boolean; unit?: string };
export type RegistryProfile = {
  version: 1; dataset: string; recordId: string; displayLabel?: string;
  sourceAsOf: string | null; observedAt: string; facts: RegistryFact[];
  identity: { legalName: string; addressLine1: string; addressLine2?: string; city?: string; state: string; postalCode: string; countryCode?: "US" | "CA" };
  provenance: { rowSha256: string; quote: string; sourceRow: Record<string, string | number | boolean | null>; localFile?: string };
  verification?: { method: "exact_legal_name_address" | "exact_registry_dba_address" | "prior_registry_binding" | "official_website_corroboration" | "reviewed_sam_domain_legal_address"; verifiedAt: string; sourceIds: string[]; website?: Record<string, unknown>; sam?: Record<string, unknown> };
  publication?: { contentHash: string; eventId: string; publishedAt: string };
};

const DATASETS: Record<string, readonly string[]> = {
  fmcsa: ["data.transportation.gov", "safer.fmcsa.dot.gov", "ai.fmcsa.dot.gov"],
  tx_surveying: ["pels.texas.gov", "tbpedownloads.s3-us-west-2.amazonaws.com"],
  tx_engineering: ["pels.texas.gov", "tbpedownloads.s3-us-west-2.amazonaws.com"],
  wa_contractors: ["data.wa.gov", "lni.wa.gov"], ca_contractors: ["cslb.ca.gov", "web.cslb.ca.gov"],
  irs_exempt: ["irs.gov", "www.irs.gov"], sba_7a: ["data.sba.gov", "sba.gov"], sba_504: ["data.sba.gov", "sba.gov"],
  sec_adv: ["sec.gov", "www.sec.gov", "data.sec.gov", "reports.adviserinfo.sec.gov"], sec_edgar: ["sec.gov", "www.sec.gov", "data.sec.gov"],
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
  firm_employees: { label: "Reported employees excluding clerical workers", unit: "employees" }, advisory_clients: { label: "Reported advisory clients", unit: "clients" },
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
export type RegistryFinding = { internalId: string; companyId: string; label: string; detail: string | null; evidence: string; sourceUrl: string; profile: RegistryProfile; officialWebsiteCorroboration?: unknown; samCorroboration?: unknown };

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
  return { internalId: input.internalId, companyId: input.companyId, label: registryProfileKey(profile), detail: input.detail ? String(input.detail) : null, evidence: input.evidence, sourceUrl: url.toString(), profile,
    ...(input.officialWebsiteCorroboration !== undefined ? { officialWebsiteCorroboration: input.officialWebsiteCorroboration } : {}),
    ...(input.samCorroboration !== undefined ? { samCorroboration: input.samCorroboration } : {}) };
}

// Formatting equivalents only: substantive name words, street numbers and unit
// identifiers survive normalization. A missing legal suffix is not a new entity.
const normalized = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
function legalName(v: string) {
  const name = normalized(v).replace(/\b(l l c|l l p|p l l c|l p|p c)$/, suffix => suffix.replace(/ /g, ""));
  const suffix = name.match(/\s+(incorporated|inc|corporation|corp|limited|ltd|llc|llp|pllc|lp|pc)$/);
  const equivalences: Record<string, string> = { incorporated: "inc", corporation: "corp", limited: "ltd" };
  return { core: suffix ? name.slice(0, suffix.index) : name, suffix: suffix ? equivalences[suffix[1]] ?? suffix[1] : null };
}
export function sameRegistryLegalName(left: string, right: string) {
  const a = legalName(left), b = legalName(right);
  return Boolean(a.core && a.core === b.core && (!a.suffix || !b.suffix || a.suffix === b.suffix));
}
function sameTerminalCompanyWord(left: string, right: string) {
  // Canonical-address admission only: retain this substantive word rather than
  // treating Company/Co as an optional legal suffix. Compound forms stay exact.
  const a = normalized(left).match(/^(.+) (company|co)$/), b = normalized(right).match(/^(.+) (company|co)$/);
  return Boolean(a && b && a[1] === b[1] && a[2] !== b[2]);
}
const addressWords: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", boulevard: "blvd", drive: "dr", lane: "ln", court: "ct",
  highway: "hwy", parkway: "pkwy", place: "pl", circle: "cir", terrace: "ter", trail: "trl",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  suite: "unit", ste: "unit", apartment: "unit", apt: "unit",
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th", sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th",
  tenth: "10th", eleventh: "11th", twelfth: "12th", thirteenth: "13th", fourteenth: "14th", fifteenth: "15th",
  sixteenth: "16th", seventeenth: "17th", eighteenth: "18th", nineteenth: "19th", twentieth: "20th",
};
function explicitFloorLine(line: string) {
  // Only a whole second address line may change floor notation. Keep suites,
  // compound designators and street numbers outside this equivalence.
  const words = line.trim().toLowerCase().split(/\s+/).map(word => addressWords[word] ?? word).join(" ");
  const match = words.match(/^(?:floor ([1-9]\d*)(st|nd|rd|th)?|([1-9]\d*)(st|nd|rd|th)? floor)$/);
  if (!match) return line;
  const digits = match[1] ?? match[3], suffix = match[2] ?? match[4], floor = Number(digits);
  if (!Number.isSafeInteger(floor)) return line;
  const expected = floor % 100 >= 11 && floor % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[floor % 10] ?? "th";
  return suffix && suffix !== expected ? line : `floor ${digits}`;
}
export function registryStreet(address: { addressLine1: string; addressLine2?: string }) {
  return normalized(`${address.addressLine1} ${address.addressLine2 ?? ""}`.replace(/#/g, " unit "))
    .replace(/\b(north|south)\s+(east|west)\b/g, "$1$2")
    .replace(/\b(suite|ste|unit|apartment|apt)(?=\d)/g, "$1 ")
    .split(" ").map(word => addressWords[word] ?? word).join(" ")
    .replace(/\bunit\s+unit\b/g, "unit")
    // Some source headers repeat the same terminal suite in both address lines.
    // Collapse only the identical unit token; different units/floors survive.
    .replace(/\bunit ([a-z0-9]+)(?: unit \1)+$/, "unit $1");
}
type RegistryStreetAddress = { addressLine1: string; addressLine2?: string; state?: string; countryCode?: string };
function albertaRangeRoad(address: RegistryStreetAddress) {
  // Alberta's rural-address notation abbreviates Range Road as RGE RD.
  // Require explicit geography and retain every civic, road and unit token.
  if (address.countryCode !== "CA" || address.state?.trim().toUpperCase() !== "AB") return null;
  const street = registryStreet(address);
  return /^\d+[a-z]? (?:rge|range) rd \d+[a-z]?(?: |$)/.test(street)
    ? street.replace(/^(\d+[a-z]?) rge rd /, "$1 range rd ") : null;
}
function vanZandtCountyRoad(address: RegistryStreetAddress) {
  // VZ CR and VZ County Road are equivalent local road labels. Restrict the
  // comparison to explicit Texas US addresses and preserve every other token.
  if (address.countryCode !== "US" || address.state?.trim().toUpperCase() !== "TX") return null;
  const street = registryStreet(address);
  return /^\d+[a-z]? vz (?:cr|county rd) \d+[a-z]?(?: |$)/.test(street)
    ? street.replace(/^(\d+[a-z]?) vz cr /, "$1 vz county rd ") : null;
}
function explicitUsBuilding(address: RegistryStreetAddress) {
  // USPS Publication 28 C2: Building = BLDG. Compare only an explicit terminal
  // designator after a civic street, retaining the complete numeric identifier.
  if (address.countryCode !== "US") return null;
  const street = registryStreet(address);
  return /^\d+[a-z]? .+ (?:building|bldg) \d+$/.test(street)
    ? street.replace(/ building (\d+)$/, " bldg $1") : null;
}
function sameExplicitUsSuite(left: RegistryStreetAddress, right: RegistryStreetAddress) {
  // Compare a whole labelled second-line suite or an explicit terminal suite in
  // line 1 with no second line. Build comparison values only; retain all source
  // fields. A single ASCII hyphen may separate one letter and identical digits.
  // Bare units, ranges, compounds and leading-zero differences remain distinct.
  if (left.countryCode !== "US" || right.countryCode !== "US"
    || !/^[A-Z]{2}$/.test(left.state?.trim().toUpperCase() ?? "")
    || left.state!.trim().toUpperCase() !== right.state?.trim().toUpperCase()) return false;
  const designator = /\b(?:suite|ste|unit|apt|apartment|building|bldg|floor)\b/i;
  const parts = (address: RegistryStreetAddress) => {
    const line2 = (address.addressLine2 ?? "").trim();
    const suite = line2
      ? line2.match(/^(?:suite|ste\.?)\s+([a-z])(-?)([0-9]+)$/i)
      : address.addressLine1.trim().match(/^(.+?)[,\s]+(?:suite|ste\.?)\s+([a-z])(-?)([0-9]+)$/i);
    if (!suite) return null;
    const street = line2 ? address.addressLine1 : suite[1];
    const index = line2 ? 1 : 2;
    if (designator.test(street)) return null;
    const base = registryStreet({ addressLine1: street });
    if (!/^\d+[a-z]? .+/.test(base) || /\b(?:unit|building|bldg|floor)\b/.test(base)) return null;
    return { base, letter: suite[index].toLowerCase(), hyphen: suite[index + 1], digits: suite[index + 2] };
  };
  const a = parts(left), b = parts(right);
  return Boolean(a && b && a.base === b.base && a.letter === b.letter && a.digits === b.digits && a.hyphen !== b.hyphen);
}
function usPlazaSuffix(address: RegistryStreetAddress) {
  // USPS Publication 28 C1 lists PLAZA -> PLZ. Require a street suffix in line 1,
  // not a building/unit name or a bare second-line token. Any remaining unit
  // must be complete and labelled; preserve every other address token.
  if (address.countryCode !== "US" || !/^[A-Z]{2}$/.test(address.state?.trim().toUpperCase() ?? "")) return null;
  const line1 = registryStreet({ addressLine1: address.addressLine1 });
  const suffix = line1.match(/^(\d+[a-z]? .+) (?:plaza|plz)(?: unit [a-z0-9]+)?$/);
  if (!suffix || /\b(?:unit|building|bldg|floor)\b/.test(suffix[1])) return null;
  if (address.addressLine2?.trim() && !/^unit [a-z0-9]+$/.test(registryStreet({ addressLine1: address.addressLine2 }))) return null;
  const street = registryStreet(address);
  return /^\d+[a-z]? .+ (?:plaza|plz)(?: unit [a-z0-9]+)?$/.test(street)
    ? street.replace(/ plaza(?= unit [a-z0-9]+$|$)/, " plz") : null;
}
function sameExplicitUsPoBox(left: RegistryStreetAddress, right: RegistryStreetAddress) {
  // Only an entire, explicitly labelled numeric PO-box first line may differ in
  // P.O./PO punctuation. Retain every box digit (including leading zeros), the
  // complete second line and geography. Omitted country is the existing US
  // registry default; an explicit non-US country is never admitted here.
  if ((left.countryCode ?? "US") !== "US" || (right.countryCode ?? "US") !== "US"
    || !/^[A-Z]{2}$/.test(left.state?.trim().toUpperCase() ?? "")
    || left.state!.trim().toUpperCase() !== right.state?.trim().toUpperCase()) return false;
  const box = /^(?:p\.\s*o\.|po)\s*box\s+([0-9]+)$/i;
  const a = left.addressLine1.trim().match(box), b = right.addressLine1.trim().match(box);
  return Boolean(a && b && a[1] === b[1]
    && registryStreet({ addressLine1: left.addressLine2 ?? "" })
      === registryStreet({ addressLine1: right.addressLine2 ?? "" }));
}
export function sameRegistryStreet(left: RegistryStreetAddress, right: RegistryStreetAddress) {
  // Keep all legacy line-split matches and fingerprints. The extra comparison
  // preserves every address token through narrowly scoped formatting rules.
  return registryStreet(left) === registryStreet(right)
    || registryStreet({ ...left, addressLine2: explicitFloorLine(left.addressLine2 ?? "") })
      === registryStreet({ ...right, addressLine2: explicitFloorLine(right.addressLine2 ?? "") })
    || (albertaRangeRoad(left) !== null && albertaRangeRoad(left) === albertaRangeRoad(right))
    || (vanZandtCountyRoad(left) !== null && vanZandtCountyRoad(left) === vanZandtCountyRoad(right))
    || (explicitUsBuilding(left) !== null && explicitUsBuilding(left) === explicitUsBuilding(right))
    || sameExplicitUsPoBox(left, right)
    || sameExplicitUsSuite(left, right)
    || (left.state?.trim().toUpperCase() === right.state?.trim().toUpperCase()
      && usPlazaSuffix(left) !== null && usPlazaSuffix(left) === usPlazaSuffix(right));
}
const postal = (v: string, country?: string) => country === "CA" ? v.toUpperCase().replace(/\s/g, "") : v.slice(0, 5);
// Keep every substantive word, including non-ASCII letters, in the whole DBA.
const normalizedDba = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
function retainedFmcsaDba(profile: RegistryProfile): string | null {
  if (profile.dataset !== "fmcsa" || !/^[1-9]\d*$/.test(profile.recordId)
    || profile.provenance.sourceRow.usdot_number !== profile.recordId
    || profile.facts.find(fact => fact.field === "usdot_number")?.value !== profile.recordId) return null;
  // The original census row is retained verbatim after the curated excerpt.
  // Its exact bytes, operator, DOT and physical fields must all agree; merely
  // mentioning a DBA elsewhere in the quote cannot establish this binding.
  const parts = profile.provenance.quote.split("\nOriginal public source row: ");
  if (parts.length !== 2 || createHash("sha256").update(parts[1]).digest("hex") !== profile.provenance.rowSha256) return null;
  let row: unknown;
  try { row = JSON.parse(parts[1]); } catch { return null; }
  const p = profile.identity;
  if (!object(row) || !text(row.dba_name, 200) || !normalizedDba(row.dba_name)
    || row.dot_number !== profile.recordId || row.legal_name !== p.legalName
    || row.phy_street !== p.addressLine1 || p.addressLine2 !== undefined
    || !text(row.phy_city, 200) || row.phy_city !== p.city
    || row.phy_state !== p.state || row.phy_zip !== p.postalCode
    || !p.countryCode || row.phy_country !== p.countryCode) return null;
  return row.dba_name;
}
export function verifyRegistryIdentity(profile: RegistryProfile, company: { name: string }, context: CompanyIdentityContext, prior: RegistryProfile[], now = new Date()): RegistryProfile["verification"] | null {
  const p = profile.identity;
  const names = [company.name, ...context.aliases];
  // Postal city aliases are immaterial only after the entire street/unit, ZIP,
  // state and compatible country agree with an independently sourced address.
  const address = context.addresses.find(a => names.some(name => sameRegistryLegalName(name, p.legalName)
      || (a.countryCode === "US" && p.countryCode === "US" && sameTerminalCompanyWord(name, p.legalName))) && sameRegistryStreet(a, p)
    && normalized(a.state ?? "") === normalized(p.state)
    && (!a.countryCode || a.countryCode === (p.countryCode ?? "US"))
    && postal(a.postalCode ?? "", p.countryCode) === postal(p.postalCode, p.countryCode));
  if (address) return { method: "exact_legal_name_address", verifiedAt: now.toISOString(), sourceIds: [address.sourceId] };
  const dba = retainedFmcsaDba(profile);
  // Whole canonical brand only: do not split DBAs, strip legal suffixes or
  // create aliases. Preserve the same complete address and country gates.
  // A shared brand/address cannot override a different known legal operator.
  const compatibleAliases = dba && context.aliases.every(alias => normalizedDba(alias) === normalizedDba(dba)
    || normalizedDba(alias) === normalizedDba(p.legalName));
  const dbaAddress = dba && compatibleAliases && normalizedDba(dba) === normalizedDba(company.name) && context.addresses.find(a => a.sourceId.trim() && sameRegistryStreet(a, p)
    && normalized(a.state ?? "") === normalized(p.state)
    && (!a.countryCode || a.countryCode === p.countryCode)
    && postal(a.postalCode ?? "", p.countryCode) === postal(p.postalCode, p.countryCode));
  if (dbaAddress) return { method: "exact_registry_dba_address", verifiedAt: now.toISOString(), sourceIds: [dbaAddress.sourceId] };
  // A previous DBA result does not skip the current original-row checks.
  const binding = prior.find(old => old.dataset === profile.dataset && old.recordId === profile.recordId && old.publication?.contentHash
    && old.verification?.sourceIds.length && ["exact_legal_name_address", "prior_registry_binding", "official_website_corroboration"].includes(old.verification.method)
    && stableRegistryJson(old.identity) === stableRegistryJson(profile.identity));
  return binding ? { method: "prior_registry_binding", verifiedAt: now.toISOString(), sourceIds: [...binding.verification!.sourceIds],
    ...(binding.verification!.website ? { website: binding.verification!.website } : {}) } : null;
}
