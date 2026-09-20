import type { GovernmentIdentityCandidate, IdentityDecision, TamIdentity } from "./types";

const LEGAL_SUFFIX = /\s+\b(co|company|corp|corporation|inc|incorporated|llc|ltd|limited|lp|llp|pllc|pc)$/;
const GENERIC = new Set(["advanced services", "business services", "complete care", "global services", "professional services", "quality services", "total solutions"]);
const SHARED_DOMAINS = new Set(["linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "sites.google.com", "wixsite.com", "wordpress.com", "godaddysites.com"]);
const STATE_NAMES = "Alabama:AL|Alaska:AK|Arizona:AZ|Arkansas:AR|California:CA|Colorado:CO|Connecticut:CT|Delaware:DE|District of Columbia:DC|Florida:FL|Georgia:GA|Hawaii:HI|Idaho:ID|Illinois:IL|Indiana:IN|Iowa:IA|Kansas:KS|Kentucky:KY|Louisiana:LA|Maine:ME|Maryland:MD|Massachusetts:MA|Michigan:MI|Minnesota:MN|Mississippi:MS|Missouri:MO|Montana:MT|Nebraska:NE|Nevada:NV|New Hampshire:NH|New Jersey:NJ|New Mexico:NM|New York:NY|North Carolina:NC|North Dakota:ND|Ohio:OH|Oklahoma:OK|Oregon:OR|Pennsylvania:PA|Rhode Island:RI|South Carolina:SC|South Dakota:SD|Tennessee:TN|Texas:TX|Utah:UT|Vermont:VT|Virginia:VA|Washington:WA|West Virginia:WV|Wisconsin:WI|Wyoming:WY|Puerto Rico:PR";
const STATES = new Map(STATE_NAMES.toUpperCase().split("|").map((entry) => entry.split(":") as [string, string]));
// Common USPS publication 28 suffix/directional spellings; preserve unit IDs.
const STREET_WORDS: Record<string, string> = { STREET: "ST", AVENUE: "AVE", ROAD: "RD", DRIVE: "DR", BOULEVARD: "BLVD", LANE: "LN", COURT: "CT", CIRCLE: "CIR", PARKWAY: "PKWY", HIGHWAY: "HWY", PLACE: "PL", TERRACE: "TER", NORTH: "N", SOUTH: "S", EAST: "E", WEST: "W", NORTHEAST: "NE", NORTHWEST: "NW", SOUTHEAST: "SE", SOUTHWEST: "SW", SUITE: "UNIT", STE: "UNIT", APARTMENT: "UNIT", APT: "UNIT", FLOOR: "FL", BUILDING: "BLDG", ROOM: "RM", DEPARTMENT: "DEPT" };
const RETRIEVAL_WORDS: Record<string, string> = { svc: "services", svcs: "services", service: "services", mgmt: "management", intl: "international", int: "international", assoc: "associates", assocs: "associates", grp: "group", sys: "systems", system: "systems", tech: "technology", technologies: "technology", facility: "facilities", logistic: "logistics", comm: "communications", comms: "communications" };
const RETRIEVAL_MODIFIERS = new Set(["and", "of", "the", "services", "solutions", "business", "professional", "global", "national", "international", "group", "holdings", "holding", "enterprises", "enterprise", "partners", "partnership", "management", "consulting", "consultants", "associates", "technology", "systems", "communications", "media", "staffing", "facilities", "logistics", "transportation", "construction", "design", "engineering", "industries"]);

export function normalizeName(value: string | null | undefined): string {
  let name = (value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim().replace(/^the /, "");
  // Corporate family words and interior name tokens are part of the identity.
  // Acme Holdings and Acme must not collapse into one direct legal recipient.
  while (LEGAL_SUFFIX.test(name)) name = name.replace(LEGAL_SUFFIX, "").trim();
  return name;
}

export function normalizeDomain(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const host = url.hostname.replace(/^www\./, "").replace(/\.$/, "");
    return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
      && !/^\d+(?:\.\d+){3}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase(), y = (b ?? "").trim().toLowerCase();
  return Boolean(x && y && x === y);
}

export function companyIdentityNames(company: Pick<TamIdentity, "name" | "legalNames">): string[] {
  const names = new Map<string, string>();
  for (const name of [company.name, ...(company.legalNames ?? [])].slice(0, 26)) {
    if (typeof name !== "string" || !name.trim() || name.length > 500) continue;
    const key = normalizeName(name);
    if (key && !names.has(key)) names.set(key, name.trim());
  }
  return [...names.values()];
}

/** Retrieval only: broaden which bounded provider rows get their full identity
 * evidence examined. These variants never establish a direct entity binding. */
export function plausibleIdentityName(expected: string | null | undefined, candidate: string | null | undefined): boolean {
  if (!expected || !candidate || expected.length > 500 || candidate.length > 500) return false;
  const a = normalizeName(expected), b = normalizeName(candidate);
  if (!a || !b) return false;
  if (a === b) return true;
  const words = (value: string) => [...new Set(value.split(" ").map(word => RETRIEVAL_WORDS[word] ?? word))].sort();
  const left = words(a), right = words(b);
  if (left.length > 20 || right.length > 20) return false;
  // Punctuation/spacing and token order are retrieval hints, not new aliases.
  if (a.replace(/ /g, "") === b.replace(/ /g, "") || left.join(" ") === right.join(" ")) return true;
  const leftDistinct = left.filter(word => word.length >= 3 && !RETRIEVAL_MODIFIERS.has(word));
  const rightDistinct = right.filter(word => word.length >= 3 && !RETRIEVAL_MODIFIERS.has(word));
  const shared = leftDistinct.filter(word => rightDistinct.includes(word));
  if (!shared.length) return false;
  // A distinctive brand plus generic legal/operating modifiers, or at least
  // two shared distinctive words with one added name token, is worth detail.
  const different = [...leftDistinct.filter(word => !rightDistinct.includes(word)), ...rightDistinct.filter(word => !leftDistinct.includes(word))];
  return different.length === 0 || shared.length >= 2 && different.length <= 1;
}

export function isPlausibleIdentityCandidate(company: Pick<TamIdentity, "name" | "legalNames" | "domain" | "website_raw">,
  candidate: GovernmentIdentityCandidate): boolean {
  const domain = normalizeDomain(company.domain) ?? normalizeDomain(company.website_raw);
  if (domain && !SHARED_DOMAINS.has(domain) && normalizeDomain(candidate.domain) === domain) return true;
  return companyIdentityNames(company).some(name => [candidate.legalName, candidate.dbaName].some(value => plausibleIdentityName(name, value)));
}

const normalizedText = (value: string | null | undefined) => (value ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
const normalizedState = (value: string | null | undefined) => STATES.get(normalizedText(value)) ?? normalizedText(value);
const normalizedCountry = (value: string | null | undefined) => {
  const text = normalizedText(value);
  return ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(text) ? "US" : text;
};
export function normalizeStreetAddress(value: string | null | undefined): string {
  return normalizedText(value?.replace(/#/g, " UNIT ")).split(/\s+/).map((word) => STREET_WORDS[word] ?? word).join(" ");
}
const normalizedPostal = (value: string | null | undefined) => {
  const text = (value ?? "").trim().toUpperCase();
  return /^\d{5}(?:[- ]?\d{4})?$/.test(text) ? text.slice(0, 5) : text.replace(/[^A-Z0-9]/g, "");
};

function addressParts(address: { addressLine1?: string | null; addressLine2?: string | null }) {
  const full = normalizeStreetAddress([address.addressLine1, address.addressLine2].filter(Boolean).join(" "));
  const marker = /\b(?:UNIT|FL|BLDG|RM|DEPT)\s+\S/.exec(full);
  return { street: marker ? full.slice(0, marker.index).trim() : full, unit: marker ? full.slice(marker.index) : null };
}

/** Shared deterministic inputs for direct matching and Jev identity resolution.
 * All CRM address values stay private; only comparison facts/provenance leave. */
export function compareIdentityAddresses(company: Pick<TamIdentity, "addresses">, candidate: GovernmentIdentityCandidate) {
  const candidateParts = addressParts(candidate);
  return (company.addresses ?? []).slice(0, 30).map((address) => {
    const parts = addressParts(address);
    const streetMatch = Boolean(parts.street && candidateParts.street && parts.street === candidateParts.street);
    const streetConflict = Boolean(parts.street && candidateParts.street && parts.street !== candidateParts.street);
    const unitMatch = Boolean(parts.unit && candidateParts.unit && parts.unit === candidateParts.unit);
    const unitConflict = Boolean(parts.unit && candidateParts.unit && parts.unit !== candidateParts.unit);
    const unitMissingOn: "company" | "candidate" | null = parts.unit && !candidateParts.unit ? "candidate" : candidateParts.unit && !parts.unit ? "company" : null;
    const unitUnspecified = !parts.unit && !candidateParts.unit;
    const postalMatch = sameText(normalizedPostal(address.postalCode), normalizedPostal(candidate.postalCode));
    const postalConflict = Boolean(address.postalCode && candidate.postalCode && !postalMatch);
    const cityMatch = sameText(normalizedText(address.city), normalizedText(candidate.city));
    const cityConflict = Boolean(address.city && candidate.city && !cityMatch);
    const stateMatch = sameText(normalizedState(address.state), normalizedState(candidate.state));
    const stateConflict = Boolean(address.state && candidate.state && !stateMatch);
    const countryConflict = Boolean(address.countryCode && candidate.countryCode
      && normalizedCountry(address.countryCode) !== normalizedCountry(candidate.countryCode));
    return { sourceKind: address.sourceKind, sourceId: address.sourceId, capturedAt: address.capturedAt,
      streetMatch, streetConflict, unitMatch, unitConflict, unitMissingOn, unitUnspecified, postalMatch, postalConflict, cityMatch, cityConflict, stateMatch, countryConflict, stateConflict,
      supportsIdentity: streetMatch && !unitConflict && !unitMissingOn && (postalMatch || cityMatch && stateMatch)
        && !countryConflict && !stateConflict && !postalConflict };
  });
}
export type IdentityAddressComparison = ReturnType<typeof compareIdentityAddresses>[number];

export function decideIdentityMatch(company: TamIdentity, candidate: GovernmentIdentityCandidate): IdentityDecision {
  const companyDomain = normalizeDomain(company.domain) ?? normalizeDomain(company.website_raw);
  const candidateDomain = normalizeDomain(candidate.domain);
  const companyName = normalizeName(company.name);
  const companyNames = companyIdentityNames(company).map(normalizeName).filter(Boolean);
  const names = [candidate.legalName, candidate.dbaName].map(normalizeName).filter(Boolean);
  const nameMatch = names.some((name) => companyNames.includes(name));
  const sharedDomain = Boolean(companyDomain && SHARED_DOMAINS.has(companyDomain));
  const domainMatch = Boolean(companyDomain && candidateDomain && companyDomain === candidateDomain && !sharedDomain);
  const domainConflict = Boolean(companyDomain && candidateDomain && companyDomain !== candidateDomain);
  const stateMatch = sameText(normalizedState(company.state), normalizedState(candidate.state));
  const cityMatch = sameText(company.city, candidate.city);
  const addressEvidence = compareIdentityAddresses(company, candidate);
  const addressMatch = addressEvidence.some((address) => address.supportsIdentity);
  const candidatePlausible = isPlausibleIdentityCandidate(company, candidate);
  // Only comparison results and provenance IDs leave the private identity
  // context; never serialize NetSuite address lines/postcodes into match evidence.
  const evidence = { companyDomain, candidateDomain, companyName, candidateNames: names, nameMatch, domainMatch, domainConflict,
    sharedDomain, stateMatch, cityMatch, addressMatch, addressEvidence, candidatePlausible };
  // A sourced exact website + legal/DBA name remains sufficient when a branch
  // or relocation makes the government's historical address differ.
  if (domainMatch && nameMatch) return { status: "verified", method: "domain", confidence: 0.98, evidence };
  if (domainConflict && nameMatch) return { status: "pending", method: "conflict", confidence: 0.5, evidence };
  if (nameMatch && addressMatch) return { status: "verified", method: "exact_name_address", confidence: 0.97, evidence };
  if (domainMatch) return { status: "pending", method: "domain_only", confidence: 0.65, evidence };
  if (nameMatch && cityMatch && stateMatch) return { status: "pending", method: "exact_name_city_state", confidence: 0.75, evidence };
  if (nameMatch && stateMatch) return { status: "pending", method: "exact_name_state", confidence: 0.6, evidence };
  if (nameMatch) return { status: "pending", method: "name_only", confidence: GENERIC.has(companyName) ? 0.35 : 0.65, evidence };
  if (candidatePlausible) return { status: "pending", method: domainConflict ? "conflict" : "name_candidate", confidence: 0.35, evidence };
  return { status: "rejected", method: "none", confidence: 0, evidence };
}
