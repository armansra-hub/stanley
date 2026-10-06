import { createHash } from "node:crypto";
import locations from "./registryCmraLocations.json";
import { registryStreet, stableRegistryJson, type RegistryProfile } from "./registryProfiles";

export type CmraLocationReference = {
  schema: "reviewed_cmra_location_reference_v1"; locationId: string; locationSha256: string;
};
type Address = Omit<RegistryProfile["identity"], "legalName">;
type Review = { taskId: string; reviewedAt: string; evidenceSha256: string };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const words = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function need(value: unknown, reason: string): asserts value { if (!value) throw Error(`registry CMRA ${reason}`); }

// New mode only: exact 100ns ordering. Preserve literal timestamps and reject
// unsupported precision/offsets; legacy website timestamp behavior is unchanged.
function instant(value: string): bigint {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?Z$/.exec(value);
  need(m && Number.isFinite(Date.parse(`${m[1]}T${m[2]}Z`)), "timestamp is invalid");
  need(new Date(`${m[1]}T00:00:00Z`).toISOString().slice(0, 10) === m[1]
    && +m[2].slice(0, 2) < 24 && +m[2].slice(3, 5) < 60 && +m[2].slice(6) < 60, "civil timestamp is invalid");
  return BigInt(Date.parse(`${m[1]}T${m[2]}Z`)) * 10000n + BigInt((m[3] ?? "").padEnd(7, "0"));
}

/** The caller selects a reviewed location, never supplies provider facts or
 * arbitrary provider URLs. Catalog edits require their own retained-source pair.
 * This is reusable location evidence: no company, box assignment or lease list. */
export function reviewedCmraLocation(reference: unknown) {
  need(object(reference) && Object.keys(reference).sort().join(",") === "locationId,locationSha256,schema"
    && reference.schema === "reviewed_cmra_location_reference_v1" && typeof reference.locationId === "string"
    && hash(reference.locationSha256), "location reference is invalid");
  const found = locations.locations.filter(location => location.id === reference.locationId);
  need(locations.schema === "reviewed_cmra_locations_v1" && found.length === 1, "reviewed location is missing or ambiguous");
  const location = found[0];
  need(sha(stableRegistryJson(location)) === reference.locationSha256, "location evidence hash differs");
  need(location.rule === "pmb_hash_same_number_without_provider_unit_v1"
    && location.sourceRole === "mailbox_format_at_reviewed_provider_location_not_customer_occupancy"
    && Object.keys(location.address).sort().join(",") === "addressLine1,city,countryCode,postalCode,state"
    && location.address.countryCode === "US" && /^[A-Z]{2}$/.test(location.address.state)
    && /^\d{5}$/.test(location.address.postalCode) && plainCivicStreet(location.address.addressLine1)
    && location.evidence.representation === "complete_retained_web_tool_text_v1"
    && hash(location.evidence.retainedResultSha256)
    && location.evidence.sources.map(s => s.role).sort().join(",") === "postal_private_mailbox_guidance,postal_secondary_unit_constraints,provider_location_mailbox_format"
    && location.evidence.sources.every(s => hash(s.retainedSectionSha256) && s.retainedSectionCharacters > 0
      && /^https:\/\/[^/?#@:]+\/[^#]*$/.test(s.url)), "location evidence is incomplete");
  const r = location.sourceReader, v = location.sourceReviewer;
  need(r.taskId && v.taskId && r.taskId !== v.taskId && hash(r.receiptSha256) && hash(v.receiptSha256)
    && r.receiptSha256 !== v.receiptSha256 && instant(v.reviewedAt) >= instant(r.reviewedAt), "location requires an actual distinct source pair");
  return location;
}

// Providers with a secondary street unit need a separately reviewed grammar.
// Reject all such tokens; never erase a suite, floor, direction or customer box.
function plainCivicStreet(street: string) {
  return /^\d+[a-z]? [a-z0-9 .'-]+$/i.test(street)
    && !/\b(?:pmb|suite|ste|unit|apt|apartment|floor|fl|bldg|building|box|po|p o|room|rm|dept|department)\b|#/i.test(street);
}
function splitMailbox(address: Address, designator: "PMB" | "#") {
  const suffix = designator === "PMB" ? /^(.*?)\s+PMB\s*(\d+)$/i : /^(.*?)\s+#\s*(\d+)$/;
  const separate = designator === "PMB" ? /^PMB\s*(\d+)$/i : /^#\s*(\d+)$/;
  let street: string, number: string;
  if (address.addressLine2 !== undefined) {
    const m = separate.exec(address.addressLine2);
    need(m, "secondary line is not the exact mailbox designator and number");
    street = address.addressLine1; number = m[1];
  } else {
    const m = suffix.exec(address.addressLine1);
    need(m, "address lacks its literal mailbox designator and number");
    street = m[1]; number = m[2];
  }
  need(plainCivicStreet(street) && number.length <= 12, "extra address unit or unsupported mailbox number");
  return { street, number };
}

export function verifyCmraMailboxAddress(reference: CmraLocationReference, original: Address, website: Address, quote: string) {
  const location = reviewedCmraLocation(reference), provider = location.address;
  const registry = splitMailbox(original, "PMB"), site = splitMailbox(website, "#");
  need(registry.number === site.number, "mailbox numbers differ");
  for (const [address, street] of [[original, registry.street], [website, site.street]] as const) {
    need(address.countryCode === "US" && address.city && words(address.city) === words(provider.city)
      && address.state === provider.state && address.postalCode === provider.postalCode
      && registryStreet({ addressLine1: street }) === registryStreet(provider), "provider civic address or complete locality differs");
  }
  // The legacy contains() discards '#'. Require the complete literal street/box
  // through city/state/ZIP, with separator-only gaps. Matching just a box prefix
  // could hide an extra suite, room or number suffix behind punctuation.
  const literal = [website.addressLine1, website.addressLine2].filter(Boolean).join(" ");
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const complete = [literal, website.city!, website.state, website.postalCode].map(escape).join("[,\\s]+");
  need(new RegExp(`(?<![A-Za-z0-9])${complete}(?![A-Za-z0-9/#-]|\\.\\d)`, "i").test(quote), "literal complete website mailbox address is absent from quote");
  return {
    ...reference, providerAddress: { ...provider }, mailboxNumber: site.number,
    sourceRole: location.sourceRole, retainedResultSha256: location.evidence.retainedResultSha256,
    sourceReader: { ...location.sourceReader }, sourceReviewer: { ...location.sourceReviewer },
    countryAttribution: "original_registry_and_reviewed_provider_location_not_website_literal",
    addressRelationship: "reviewed_mail_correspondence_not_occupancy_or_canonical_address_equivalence",
  };
}

export function verifyCmraReviews(reference: CmraLocationReference, observedAt: string, registryObservedAt: string,
  reader: Review, reviewer: Review, now: Date) {
  const location = reviewedCmraLocation(reference), at = instant(now.toISOString());
  const sources = [observedAt, registryObservedAt, location.sourceReader.reviewedAt, location.sourceReviewer.reviewedAt].map(instant);
  const first = instant(reader.reviewedAt), second = instant(reviewer.reviewedAt);
  need(sources.every(t => first >= t) && second >= first && second <= at + 600_000_000n
    && at - first <= 7n * 86_400n * 10_000_000n, "final reviews precede sources, are stale or are future dated");
}
