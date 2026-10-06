import { verifyFirmLicenseBridge, type FirmLicenseBridge } from "./registryFirmLicenseBridge";
import { verifyRegisteredAgentOperator, registeredAgentOperatorInstant, type RegisteredAgentOperatorBridge } from "./registryRegisteredAgentOperator";
import { verifyRegistryNppesOtherName, type RegistryNppesOtherNameEntry } from "./registryNppesOtherName";
import { verifyRegistryNppesEndpoint, type RegistryNppesEndpointEntry } from "./registryNppesEndpoint";
import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { registryContentHash, retainedFmcsaDba, sameRegistryLegalName, sameRegistryStreet, normalizedDba, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import { registrySamCanonicalHash } from "./registrySam";
import catalog from "./registryOfficialApiEntries.json";

type Witness = { taskId: string; reviewedAt: string; evidenceSha256: string };
type SourceReview = { taskId: string; reviewedAt: string; receiptSha256: string };
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
type Address = { addressLine1: string; addressLine2?: string; city?: string; state?: string; postalCode?: string; countryCode?: string };
type Role = "entity_mailing" | "registered_agent_street" | "registered_agent_mailing" | "carrier_mailing";
export type RegistryOfficialApiTradeBundle = {
  id: string; companyId: string; internalId: string; canonicalDomain: string; entityId: string; legalName: string;
  tradeNames: readonly { name: string; documentId: string; effectiveDate: string }[];
  sourceReader: SourceReview; sourceReviewer: SourceReview; sources: readonly { observedAt: string }[];
  anchor: { role: string; address: Address };
};
type RegisteredTradeNameBridge = {
  schema: "registered_trade_name_alias_v1"; bundleId: string; bundleSha256: string; entityId: string;
  tradeNameDocumentId: string; tradeName: string; canonicalName: string; canonicalAlias: string;
};
type OwnSiteOperatorBridge = {
  schema: "own_site_full_operator_name_v1"; canonicalName: string; legalOperator: string; siteLegalOperator: string;
  pages: { role: "operator_definition" | "company_headquarters"; requestedUrl: string; finalUrl: string; status: number;
    contentType: string; observedAt: string; htmlSha256: string; textSha256: string; receiptSha256: string; text: string;
    hops: { url: string; status: number }[] }[];
  operatorQuote: string; contactQuote: string; address: Address; phone: string; phoneAsDisplayed: string;
  sourceReader: SourceReview; sourceReviewer: SourceReview;
};
export type RegistryOfficialApiEntry = {
  id: string; companyId: string; internalId: string; canonicalDomain: string; canonicalIdentitySha256: string;
  sourceKind: "colorado_business_entity" | "fmcsa_census";
  source: { requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
    responseSha256: string; receiptSha256: string; rawRow: string; rawRowSha256: string; arrayIndex: number; byteOffset: number; byteLength: number };
  sourceReader: SourceReview; sourceReviewer: SourceReview;
  originalReviews: { primary: SourceReview; independent: SourceReview; packetSha256: string };
  target: { dataset: "co_sos" | "fmcsa"; recordId: string; sourceUrl: string; rowSha256: string; evidenceSha256: string;
    identitySha256: string; sourceRowSha256: string; factsSha256: string; sourceAsOf: string | null; observedAt: string };
  nameBridge?: RegisteredTradeNameBridge;
  siteOperatorBridge?: OwnSiteOperatorBridge;
  registeredAgentOperatorBridge?: RegisteredAgentOperatorBridge;
  firmLicenseBridge?: FirmLicenseBridge;
  anchor: { mode: "address_role"; role: Role; sourceId: string } | { mode: "company_email_domain" } | { mode: "reviewed_registered_agent_operator" } | { mode: "reviewed_colorado_firm_license" };
};
export type RegistryOfficialApiCorroboration = {
  schema: "official_api_roles_v1"; entryId: string; entrySha256: string; canonicalIdentitySha256: string;
  reader: Witness; reviewer: Witness;
};
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const iso = (v: unknown): v is string => typeof v === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const validTask = (v: unknown): v is string => typeof v === "string" && v.length <= 160 && /^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(v);
function need(value: unknown, reason: string): asserts value { if (!value) throw new Error(`official API ${reason}`); }
/** Match the JSON shape returned by canonical identity reads. Undefined optional
 * address properties carry no supplied value; retain null, values, address order
 * and every provenance field. Existing SAM/history hashing is unchanged. */
export function registryOfficialApiCanonicalHash(company: Company, context: CompanyIdentityContext) {
  return registrySamCanonicalHash(company, { ...context,
    addresses: context.addresses.map(address => Object.fromEntries(
      Object.entries(address).filter(([, value]) => value !== undefined),
    ) as typeof address),
  });
}
export function registryOfficialApiEvidenceHash(row: RegistryFinding, proof: Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">) {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId,
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail), evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
// Reviewed deployment data is the trust boundary; callers supply only its exact
// ID/hash and actual final witnesses. No caller-authored source transcription.
export function registryOfficialApiEntry(id: string) {
  const entries = catalog.entries as (RegistryOfficialApiEntry | RegistryNppesEndpointEntry | RegistryNppesOtherNameEntry)[], matches = entries.filter(e => e.id === id);
  need(catalog.version === 1 && entries.length <= 1000 && matches.length === 1, "entry missing or ambiguous");
  return { entry: JSON.parse(JSON.stringify(matches[0])) as RegistryOfficialApiEntry | RegistryNppesEndpointEntry | RegistryNppesOtherNameEntry, sha256: sha(stableRegistryJson(matches[0])) };
}
function host(value: string): string | null {
  // A canonical root/domain may be a URL, but paths, credentials, ports and IPs
  // cannot smuggle a different email-domain identity into this mode.
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`), h = u.hostname.toLowerCase().replace(/^www\./, "");
    return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.port && !u.search && !u.hash && u.pathname === "/"
      && h.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) ? h : null;
  } catch { return null; }
}
const providers = ["gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com", "mac.com", "mail.com", "proton.me", "protonmail.com", "comcast.net", "att.net", "sbcglobal.net", "verizon.net", "cox.net", "bellsouth.net", "charter.net", "earthlink.net", "gmx.com", "zoho.com", "onmicrosoft.com", "wixsite.com", "wordpress.com", "weebly.com", "godaddysites.com", "blogspot.com", "github.io", "webflow.io", "sites.google.com"];
function emailDomain(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254 || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+$/.test(value)) return null;
  const [local, domain] = value.split("@");
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  const h = domain.toLowerCase();
  return host(h) === h && !providers.some(p => h === p || h.endsWith(`.${p}`)) ? h : null;
}
function fullAddress(a: Address, b: Address) {
  if (!a.addressLine1 || !b.addressLine1 || !a.city || !b.city || !a.state || !b.state || !a.postalCode || !b.postalCode
    || !["US", "CA"].includes(a.countryCode ?? "") || a.countryCode !== b.countryCode
    || words(a.city) !== words(b.city) || a.state.toUpperCase() !== b.state.toUpperCase()) return false;
  const az = a.postalCode.replace(/[ -]/g, "").toUpperCase(), bz = b.postalCode.replace(/[ -]/g, "").toUpperCase();
  const postal = a.countryCode === "CA" ? /^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(az) && az === bz
    : /^\d{5}(?:\d{4})?$/.test(az) && /^\d{5}(?:\d{4})?$/.test(bz) && az.slice(0, 5) === bz.slice(0, 5) && !(az.length === 9 && bz.length === 9 && az !== bz);
  return postal && sameRegistryStreet(a, b);
}
function address(source: Record<string, unknown>, kind: RegistryOfficialApiEntry["sourceKind"], role: "original_physical" | Role): Address {
  let keys: string[];
  if (kind === "colorado_business_entity") {
    const prefix = { original_physical: "principal", entity_mailing: "mailing", registered_agent_street: "agentprincipal", registered_agent_mailing: "agentmailing" }[role as Exclude<typeof role, "carrier_mailing">];
    need(prefix, "Colorado address role invalid");
    keys = ["address1", "address2", "city", "state", "zipcode", "country"].map(k => prefix + k);
  } else {
    need(role === "original_physical" || role === "carrier_mailing", "carrier address role invalid");
    const prefix = role === "original_physical" ? "phy_" : "carrier_mailing_";
    keys = [prefix + "street", "", prefix + "city", prefix + "state", prefix + "zip", prefix + "country"];
  }
  const [line1, line2, city, state, zip, country] = keys.map(k => k ? source[k] : undefined);
  need([line1, city, state, zip, country].every(v => typeof v === "string" && v.length > 0 && v.length <= 200)
    && (line2 === undefined || typeof line2 === "string" && line2.length <= 200), "incomplete role address");
  return { addressLine1: line1 as string, ...(line2 ? { addressLine2: line2 as string } : {}), city: city as string, state: state as string, postalCode: zip as string, countryCode: country as string };
}
function sourceUrl(value: string, kind: RegistryOfficialApiEntry["sourceKind"], recordId: string) {
  try {
    const u = new URL(value), co = kind === "colorado_business_entity", field = co ? "entityid" : "dot_number";
    if (u.protocol !== "https:" || u.hostname !== (co ? "data.colorado.gov" : "data.transportation.gov") || u.pathname !== (co ? "/resource/4ykn-tg5h.json" : "/resource/az4n-8mr2.json")
      || u.username || u.password || u.port || u.hash || value.length > 4096) return false;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(k => !["$where", "$select", "$order", "$limit"].includes(k))) return false;
    const match = u.searchParams.get("$where")?.match(new RegExp(`^${field}\\s+in\\s*\\(([0-9, ]+)\\)$`));
    const ids = match?.[1].split(",").map(s => s.trim());
    const limit = Number(u.searchParams.get("$limit"));
    return !!ids && ids.length <= 1000 && new Set(ids).size === ids.length && ids.includes(recordId) && ids.every(id => /^\d+$/.test(id))
      && u.searchParams.get("$order") === field && Number.isInteger(limit) && limit >= ids.length && limit <= 1000
      && !!u.searchParams.get("$select")?.split(",").includes(field);
  } catch { return false; }
}
function verifyOriginal(row: RegistryFinding, entry: RegistryOfficialApiEntry, source: Record<string, unknown>) {
  const p = row.profile, t = entry.target;
  need(p.dataset === t.dataset && p.recordId === t.recordId && row.sourceUrl === t.sourceUrl && p.sourceAsOf === t.sourceAsOf && p.observedAt === t.observedAt
    && p.provenance.rowSha256 === t.rowSha256 && sha(row.evidence) === t.evidenceSha256 && row.evidence === p.provenance.quote
    && sha(stableRegistryJson(p.identity)) === t.identitySha256 && sha(stableRegistryJson(p.provenance.sourceRow)) === t.sourceRowSha256
    && sha(stableRegistryJson(p.facts.map(({ field, value }) => ({ field, value })))) === t.factsSha256, "original target content changed");
  let original: unknown;
  const text = p.dataset === "fmcsa" ? row.evidence.split("\nOriginal public source row: ") : [row.evidence];
  need(text.length === (p.dataset === "fmcsa" ? 2 : 1), "complete original source row required");
  try { original = JSON.parse(text[text.length - 1]); } catch { throw new Error("official API original JSON invalid"); }
  need(object(original) && sha(text[text.length - 1]) === p.provenance.rowSha256, "original raw row hash differs");
  const co = entry.sourceKind === "colorado_business_entity", idField = co ? "entityid" : "dot_number", nameField = co ? "entityname" : "legal_name";
  need((co ? p.dataset === "co_sos" && /^\d{11}$/.test(p.recordId) : p.dataset === "fmcsa" && /^[1-9]\d*$/.test(p.recordId))
    && original[idField] === p.recordId && source[idField] === p.recordId && original[nameField] === p.identity.legalName
    && source[nameField] === original[nameField], "record ID or legal operator differs");
  const oldPhysical = address(original, entry.sourceKind, "original_physical"), currentPhysical = address(source, entry.sourceKind, "original_physical");
  need(oldPhysical.addressLine1 === p.identity.addressLine1 && (oldPhysical.addressLine2 ?? "") === (p.identity.addressLine2 ?? "")
    && oldPhysical.city === p.identity.city && oldPhysical.state === p.identity.state && oldPhysical.postalCode === p.identity.postalCode && oldPhysical.countryCode === p.identity.countryCode
    && ["addressLine1", "addressLine2", "city", "state", "postalCode", "countryCode"].every(k => (oldPhysical[k as keyof Address] ?? "") === (currentPhysical[k as keyof Address] ?? "")), "original physical address changed or unbridged");
  const url = new URL(row.sourceUrl);
  const exactTargetUrl = co
    ? url.hostname === "data.colorado.gov" && url.pathname === "/resource/4ykn-tg5h.json" && [...url.searchParams.keys()].length === 1 && url.searchParams.get("entityid") === p.recordId
    : url.hostname === "safer.fmcsa.dot.gov" && url.pathname === "/query.asp" && [...url.searchParams.keys()].length === 4
      && url.searchParams.getAll("query_string").length === 1 && url.searchParams.get("query_string") === p.recordId
      && url.searchParams.get("searchtype") === "ANY" && url.searchParams.get("query_type") === "queryCarrierSnapshot" && url.searchParams.get("query_param") === "USDOT";
  need(url.protocol === "https:" && !url.username && !url.password && !url.port && !url.hash && exactTargetUrl, "original target URL differs");
  if (!co) need((original.dba_name ?? "") === (source.dba_name ?? ""), "raw DBA changed or unbridged");
  return currentPhysical;
}
// Opt-in deployed catalog association. The dispatcher supplies its already
// reviewed private history bundle; no proof caller supplies names or documents.
function registeredTradeAssociation(entry: RegistryOfficialApiEntry, company: Company, context: CompanyIdentityContext,
  legal: string, dba: string | null, bundle?: RegistryOfficialApiTradeBundle) {
  if (!Object.hasOwn(entry, "nameBridge")) return null;
  const b = entry.nameBridge, keys = ["schema", "bundleId", "bundleSha256", "entityId", "tradeNameDocumentId", "tradeName", "canonicalName", "canonicalAlias"];
  need(b && object(b) && Object.keys(b).length === keys.length && keys.every(k => Object.hasOwn(b, k))
    && b.schema === "registered_trade_name_alias_v1" && entry.sourceKind === "fmcsa_census" && entry.anchor.mode === "company_email_domain", "registered trade bridge shape or scope invalid");
  need(bundle && b.bundleId === bundle.id && hash(b.bundleSha256) && b.bundleSha256 === sha(stableRegistryJson(bundle))
    && b.entityId === bundle.entityId && bundle.companyId === entry.companyId && bundle.internalId === entry.internalId
    && bundle.canonicalDomain === entry.canonicalDomain && sameRegistryLegalName(legal, bundle.legalName), "registered trade reviewed bundle or operator differs");
  const trades = bundle.tradeNames.filter(t => t.documentId === b.tradeNameDocumentId && t.name === b.tradeName);
  need(trades.length === 1 && /^\d{11}$/.test(trades[0].documentId) && /^\d{4}-\d{2}-\d{2}$/.test(trades[0].effectiveDate)
    && !!dba && normalizedDba(dba) === normalizedDba(trades[0].name)
    && company.name === b.canonicalName && typeof b.canonicalName === "string" && b.canonicalName.length > 0
    && context.aliases.filter(n => n === b.canonicalAlias).length === 1
    && normalizedDba(b.canonicalAlias) === normalizedDba(trades[0].name)
    && context.aliases.every(n => sameRegistryLegalName(n, bundle.legalName) || normalizedDba(n) === normalizedDba(trades[0].name)), "registered trade canonical alias or complete DBA differs");
  const reviews = [bundle.sourceReader, bundle.sourceReviewer];
  need(reviews.every(r => validTask(r.taskId) && iso(r.reviewedAt) && hash(r.receiptSha256)) && reviews[0].taskId !== reviews[1].taskId
    && Date.parse(reviews[1].reviewedAt) >= Date.parse(reviews[0].reviewedAt) && bundle.sources.length > 0
    && bundle.sources.every(s => iso(s.observedAt) && Date.parse(reviews[0].reviewedAt) >= Date.parse(s.observedAt)), "registered trade actual source lineage invalid");
  // This anchors the registered-name relationship to canonical context only.
  // It does not equate the carrier's literal physical/mailing street to it.
  const anchors = context.addresses.filter(a => ["netsuite_record", "company_website"].includes(a.sourceKind)
    && !!a.sourceId && iso(a.capturedAt) && fullAddress(a, bundle.anchor.address));
  need(bundle.anchor.role === "principal_office" && anchors.length === 1, "registered trade complete canonical relationship anchor missing or ambiguous");
  return { ...b, legalName: bundle.legalName, tradeNameEffectiveDate: trades[0].effectiveDate,
    sourceReader: bundle.sourceReader, sourceReviewer: bundle.sourceReviewer, canonicalAnchor: anchors[0] };
}
// Opt-in deployment-reviewed full operator/name association. Names, complete
// source texts and review receipts live in the catalog, never the caller proof.
function ownSiteOperatorAssociation(entry: RegistryOfficialApiEntry, company: Company, context: CompanyIdentityContext,
  source: Record<string, unknown>, physical: Address, legal: string, dba: string | null) {
  if (!Object.hasOwn(entry, "siteOperatorBridge")) return null;
  const b = entry.siteOperatorBridge;
  const keys = ["schema", "canonicalName", "legalOperator", "siteLegalOperator", "pages", "operatorQuote", "contactQuote", "address", "phone", "phoneAsDisplayed", "sourceReader", "sourceReviewer"];
  need(b && object(b) && Object.keys(b).length === keys.length && keys.every(k => Object.hasOwn(b, k))
    && b.schema === "own_site_full_operator_name_v1" && !Object.hasOwn(entry, "nameBridge")
    && entry.sourceKind === "fmcsa_census" && entry.anchor.mode === "company_email_domain" && !dba,
  "own-site operator bridge scope invalid");
  need(entry.companyId === "11009a6b-2254-4413-8e68-4d068e76966d" && entry.internalId === "156219876"
    && entry.canonicalDomain === "ratrucking.com" && entry.target.dataset === "fmcsa" && entry.target.recordId === "164773",
  "own-site operator finite target differs");
  need(typeof b.canonicalName === "string" && b.canonicalName === company.name && b.canonicalName.length > 0
    && b.legalOperator === legal && sameRegistryLegalName(b.siteLegalOperator, legal)
    && context.aliases.every(n => n === company.name || sameRegistryLegalName(n, legal)), "own-site complete operator or canonical name differs");
  need(Array.isArray(b.pages) && b.pages.length === 2 && b.pages[0].role === "operator_definition" && b.pages[1].role === "company_headquarters",
    "own-site operator page roles differ");
  const ownPage = (value: string, final = false) => {
    try { const u = new URL(value); return (final ? u.protocol === "https:" : ["http:", "https:"].includes(u.protocol))
      && u.hostname.replace(/^www\./, "") === entry.canonicalDomain && !u.username && !u.password && !u.port && !u.search && !u.hash; } catch { return false; }
  };
  for (const page of b.pages) {
    need(page.status === 200 && /^text\/html(?:;|$)/i.test(page.contentType) && iso(page.observedAt)
      && ownPage(page.requestedUrl) && ownPage(page.finalUrl, true) && [page.htmlSha256, page.textSha256, page.receiptSha256].every(hash)
      && typeof page.text === "string" && page.text.length > 0 && page.text.length <= 100000 && sha(page.text) === page.textSha256
      && Array.isArray(page.hops) && page.hops.length >= 1 && page.hops.length <= 3
      && page.hops[0].url === page.requestedUrl && page.hops.at(-1)!.url === page.finalUrl
      && page.hops.every((h, i) => ownPage(h.url, i === page.hops.length - 1)
        && (i === page.hops.length - 1 ? h.status === 200 : [301, 302, 307, 308].includes(h.status))), "own-site source capture or full text invalid");
  }
  const [operatorPage, contactPage] = b.pages;
  need(operatorPage.finalUrl !== contactPage.finalUrl && b.operatorQuote.length > 0 && b.contactQuote.length > 0
    && operatorPage.text.split(b.operatorQuote).length === 2 && contactPage.text.split(b.contactQuote).length === 2
    && b.operatorQuote.startsWith(`ABOUT ${b.canonicalName.toUpperCase()} ${b.siteLegalOperator}, is `)
    && !/\b(not|never|unrelated|formerly|previously|former|previous|customer|client|partner|affiliate|subsidiary|parent|example|sample|fictional)\b/i.test(b.operatorQuote)
    && b.contactQuote.includes("HEADQUARTERS COMPANY INFORMATION ") && b.contactQuote.includes(b.siteLegalOperator.toUpperCase())
    && !/\b(not|never|unrelated|former|previous|customer|client|affiliate|subsidiary|registered agent)\b/i.test(b.contactQuote), "own-site operator definition or contact attribution differs");
  const a = b.address;
  need(a.countryCode === "US" && fullAddress(a, physical) && a.city && a.state && a.postalCode
    && [a.addressLine1, a.addressLine2, `${a.city}, ${a.state} ${a.postalCode}`].filter(Boolean).every(s => b.contactQuote.includes(s!))
    && /^\d{10}$/.test(b.phone) && source.phone === b.phone && typeof b.phoneAsDisplayed === "string"
    && /^[0-9.() -]+$/.test(b.phoneAsDisplayed) && b.phoneAsDisplayed.replace(/\D/g, "") === b.phone
    && b.contactQuote.includes(b.phoneAsDisplayed) && emailDomain(source.email_address) === entry.canonicalDomain,
  "own-site complete physical address, phone or company email differs");
  const anchors = context.addresses.filter(a => ["netsuite_record", "company_website"].includes(a.sourceKind)
    && !!a.sourceId && iso(a.capturedAt) && fullAddress(a, b.address));
  need(anchors.length === 1, "own-site complete canonical address missing or ambiguous");
  const reviews = [b.sourceReader, b.sourceReviewer];
  need(reviews.every(r => validTask(r.taskId) && iso(r.reviewedAt) && hash(r.receiptSha256))
    && reviews[0].taskId !== reviews[1].taskId && Date.parse(reviews[1].reviewedAt) >= Date.parse(reviews[0].reviewedAt)
    && reviews.every(r => Date.parse(r.reviewedAt) >= Date.parse(entry.source.observedAt)
      && b.pages.every(p => Date.parse(r.reviewedAt) >= Date.parse(p.observedAt))), "own-site actual source review lineage invalid");
  return { ...b, canonicalAnchor: anchors[0] };
}

export function verifyRegistryOfficialApi(row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now = new Date(), reviewedTradeBundle?: RegistryOfficialApiTradeBundle): NonNullable<RegistryProfile["verification"]> {
  const keys = ["schema", "entryId", "entrySha256", "canonicalIdentitySha256", "reader", "reviewer"];
  need(object(raw) && Object.keys(raw).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(raw, k)) && raw.schema === "official_api_roles_v1" && typeof raw.entryId === "string", "proof shape invalid");
  const { entry, sha256 } = registryOfficialApiEntry(raw.entryId);
  if (entry.sourceKind === "nppes_organization_dba") {
    const { reader, reviewer, ...evidence } = raw;
    return verifyRegistryNppesOtherName(row, raw as RegistryOfficialApiCorroboration, entry, company, context, now, {
      entrySha256: sha256, canonicalIdentitySha256: registryOfficialApiCanonicalHash(company, context),
      evidenceSha256: registryOfficialApiEvidenceHash(row, evidence as Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">),
      canonicalDomain: host(company.domain || company.website_raw || ""),
    });
  }
  if (entry.sourceKind === "nppes_organization_endpoint") {
    const { reader, reviewer, ...evidence } = raw;
    return verifyRegistryNppesEndpoint(row, raw as RegistryOfficialApiCorroboration, entry, company, context, now, {
      entrySha256: sha256, canonicalIdentitySha256: registryOfficialApiCanonicalHash(company, context),
      evidenceSha256: registryOfficialApiEvidenceHash(row, evidence as Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">),
      canonicalDomain: host(company.domain || company.website_raw || ""), endpointDomain: emailDomain,
    });
  }
  const source = entry.source;
  const operatorMode = entry.anchor.mode === "reviewed_registered_agent_operator", licenseMode = entry.anchor.mode === "reviewed_colorado_firm_license";
  need(licenseMode === Object.hasOwn(entry, "firmLicenseBridge") && (!licenseMode || entry.sourceKind === "colorado_business_entity"
    && !Object.hasOwn(entry, "nameBridge") && !Object.hasOwn(entry, "siteOperatorBridge") && !Object.hasOwn(entry, "registeredAgentOperatorBridge")
    && !providers.some(p => entry.canonicalDomain === p || entry.canonicalDomain.endsWith(`.${p}`))), "firm license scope differs");
  need(operatorMode === Object.hasOwn(entry, "registeredAgentOperatorBridge")
    && (!operatorMode || entry.sourceKind === "colorado_business_entity" && !Object.hasOwn(entry, "nameBridge")
      && !Object.hasOwn(entry, "siteOperatorBridge") && !providers.some(p => entry.canonicalDomain === p || entry.canonicalDomain.endsWith(`.${p}`))),
  "registered-agent operator scope differs");
  need(raw.entrySha256 === sha256 && ["colorado_business_entity", "fmcsa_census"].includes(entry.sourceKind), "entry pin or source kind invalid");
  need(source.status === 200 && source.contentType.toLowerCase().startsWith("application/json") && iso(source.observedAt)
    && source.requestedUrl === source.finalUrl && sourceUrl(source.requestedUrl, entry.sourceKind, entry.target.recordId)
    && [source.responseSha256, source.receiptSha256, source.rawRowSha256].every(hash) && source.rawRow.length <= 16000 && sha(source.rawRow) === source.rawRowSha256
    && Number.isInteger(source.arrayIndex) && source.arrayIndex >= 0 && Number.isInteger(source.byteOffset) && source.byteOffset >= 0 && Buffer.byteLength(source.rawRow, "utf8") === source.byteLength, "source capture or exact row invalid");
  let parsed: unknown; try { parsed = JSON.parse(source.rawRow); } catch { throw new Error("official API reviewed JSON invalid"); }
  need(object(parsed) && Object.values(parsed).every(v => typeof v === "string" && v.length <= 1000), "source row must preserve literal scalar fields");
  const reviews = [entry.sourceReader, entry.sourceReviewer], originals = [entry.originalReviews.primary, entry.originalReviews.independent];
  need(reviews[0].taskId !== reviews[1].taskId && originals[0].taskId !== originals[1].taskId && hash(entry.originalReviews.packetSha256)
    && [...reviews, ...originals].every(a => validTask(a.taskId) && iso(a.reviewedAt) && hash(a.receiptSha256))
    && reviews.every(a => Date.parse(a.reviewedAt) >= Date.parse(source.observedAt))
    && originals.every(a => Date.parse(a.reviewedAt) >= Date.parse(row.profile.observedAt))
    && Date.parse(reviews[1].reviewedAt) >= Date.parse(reviews[0].reviewedAt)
    && Date.parse(originals[1].reviewedAt) >= Date.parse(originals[0].reviewedAt), "actual source review lineage invalid");
  if (licenseMode) need(reviews.every(review => registeredAgentOperatorInstant(review.reviewedAt) >= registeredAgentOperatorInstant(source.observedAt)), "firm license exact main source chronology differs");
  const physical = verifyOriginal(row, entry, parsed), legal = row.profile.identity.legalName, dba = entry.sourceKind === "fmcsa_census" ? retainedFmcsaDba(row.profile) : null;
  const nameBridge = registeredTradeAssociation(entry, company, context, legal, dba, reviewedTradeBundle);
  const siteBridge = ownSiteOperatorAssociation(entry, company, context, parsed, physical, legal, dba);
  const compatible = (name: string) => sameRegistryLegalName(name, legal) || !!dba && normalizedDba(name) === normalizedDba(dba);
  need(company.id === entry.companyId && row.companyId === entry.companyId && company.netsuite_internal_id === entry.internalId && row.internalId === entry.internalId
    && host(company.domain || company.website_raw || "") === entry.canonicalDomain && hash(entry.canonicalIdentitySha256)
    && raw.canonicalIdentitySha256 === entry.canonicalIdentitySha256 && raw.canonicalIdentitySha256 === registryOfficialApiCanonicalHash(company, context)
    && (nameBridge !== null || siteBridge !== null || compatible(company.name) && context.aliases.every(compatible)), "canonical identity or known legal operator conflict");
  let anchor: CompanyIdentityContext["addresses"][number] | null = null, roleAddress: Address | null = null, email: string | null = null;
  if (entry.anchor.mode === "address_role") {
    const role = entry.anchor;
    roleAddress = address(parsed, entry.sourceKind, role.role);
    const anchors = context.addresses.filter(a => a.sourceId === role.sourceId && ["netsuite_record", "company_website"].includes(a.sourceKind) && iso(a.capturedAt) && fullAddress(a, roleAddress!));
    need(anchors.length === 1, "complete canonical role anchor missing or ambiguous"); anchor = anchors[0];
  } else if (operatorMode || licenseMode) {
    need(Object.keys(entry.anchor).length === 1, "operator anchor shape differs");
  } else {
    need(entry.anchor.mode === "company_email_domain" && entry.sourceKind === "fmcsa_census", "contact anchor mode invalid");
    email = emailDomain(parsed.email_address);
    need(email && email === entry.canonicalDomain, "strict company email domain differs or is shared");
  }
  const agentOperator = operatorMode ? verifyRegisteredAgentOperator({ bridge: entry.registeredAgentOperatorBridge!,
    source: parsed, legal, company, context, domain: entry.canonicalDomain, observedAt: source.observedAt,
    sourceReader: entry.sourceReader, sourceReviewer: entry.sourceReviewer }) : null;
  const firmLicense = licenseMode ? verifyFirmLicenseBridge({ bridge: entry.firmLicenseBridge!, source: parsed, domain: entry.canonicalDomain,
    companyName: company.name, sourceReader: entry.sourceReader, sourceReviewer: entry.sourceReviewer }) : null;
  const { reader, reviewer, ...evidence } = raw, bound = registryOfficialApiEvidenceHash(row, evidence as Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">);
  const earliest = Math.max(Date.parse(row.profile.observedAt), Date.parse(source.observedAt), ...[...reviews, ...originals].map(a => Date.parse(a.reviewedAt)), anchor ? Date.parse(anchor.capturedAt) : 0,
    ...(nameBridge ? [Date.parse(nameBridge.sourceReader.reviewedAt), Date.parse(nameBridge.sourceReviewer.reviewedAt), Date.parse(nameBridge.canonicalAnchor.capturedAt)] : []),
    ...(siteBridge ? [Date.parse(siteBridge.sourceReader.reviewedAt), Date.parse(siteBridge.sourceReviewer.reviewedAt), Date.parse(siteBridge.canonicalAnchor.capturedAt)] : []));
  for (const witness of [reader, reviewer]) need(object(witness) && Object.keys(witness).every(k => ["taskId", "reviewedAt", "evidenceSha256"].includes(k)) && validTask(witness.taskId)
    && iso(witness.reviewedAt) && Date.parse(witness.reviewedAt) >= earliest && Date.parse(witness.reviewedAt) <= now.getTime() + 60000
    && now.getTime() - Date.parse(witness.reviewedAt) <= 7 * 86400000 && witness.evidenceSha256 === bound, "final review does not bind exact content");
  need((reader as Witness).taskId !== (reviewer as Witness).taskId && Date.parse((reviewer as Witness).reviewedAt) >= Date.parse((reader as Witness).reviewedAt), "distinct ordered final review required");
  if (operatorMode || licenseMode) {
    // The new reviewed operator mode preserves exact 100ns ordering; all legacy
    // modes retain their existing timestamp behavior above.
    const ticks = registeredAgentOperatorInstant;
    const sourceTimes = [row.profile.observedAt, source.observedAt, ...[...reviews, ...originals].map(w => w.reviewedAt)].map(ticks);
    const first = ticks((reader as Witness).reviewedAt), second = ticks((reviewer as Witness).reviewedAt);
    const current = BigInt(now.getTime()) * 10000n;
    need(sourceTimes.every(t => first >= t) && second >= first
      && [first, second].every(t => t <= current + 60000n * 10000n && current - t <= 7n * 86400000n * 10000n),
    "registered-agent operator exact final chronology differs");
  }
  return { method: "reviewed_official_registration_history", verifiedAt: now.toISOString(), sourceIds: [`${row.profile.dataset}:${row.profile.recordId}:${sha256}`, ...(anchor ? [anchor.sourceId] : []), ...(nameBridge ? [`co_sos:${nameBridge.entityId}:${nameBridge.bundleSha256}`, nameBridge.canonicalAnchor.sourceId] : []), ...(siteBridge ? [siteBridge.canonicalAnchor.sourceId] : []), ...(agentOperator ? agentOperator.pages.map(p => `website:sha256:${p.textSha256}`) : []), ...(firmLicense ? [`firm-license:${firmLicense.licenseToken}:${firmLicense.license.rawRowSha256}`, `trade-owner:${firmLicense.trade.rawRowSha256}`, `website:sha256:${firmLicense.ownSite.textSha256}`] : [])],
    officialHistory: { ...evidence, reader, reviewer, evidenceSha256: bound, entry, canonicalAnchor: anchor, roleAddress, companyEmailDomain: email, ...(nameBridge ? { registeredTradeNameBridge: nameBridge } : {}), ...(siteBridge ? { ownSiteOperatorNameBridge: siteBridge } : {}), ...(agentOperator ? { registeredAgentOperatorCorrespondence: agentOperator } : {}), ...(firmLicense ? { coloradoFirmLicenseAssociation: firmLicense } : {}),
      targetAddress: { role: entry.sourceKind === "fmcsa_census" ? "carrier_physical" : "principal_street", ...physical },
      scope: "Reviewed official API entity/contact role association at the retained observation date. Original physical facts remain unchanged; mailing and registered-agent addresses are not operating locations. A declared company email domain does not establish current website ownership or contact permission." } };
}
