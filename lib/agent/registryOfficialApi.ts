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
export type RegistryOfficialApiEntry = {
  id: string; companyId: string; internalId: string; canonicalDomain: string; canonicalIdentitySha256: string;
  sourceKind: "colorado_business_entity" | "fmcsa_census";
  source: { requestedUrl: string; finalUrl: string; status: number; contentType: string; observedAt: string;
    responseSha256: string; receiptSha256: string; rawRow: string; rawRowSha256: string; arrayIndex: number; byteOffset: number; byteLength: number };
  sourceReader: SourceReview; sourceReviewer: SourceReview;
  originalReviews: { primary: SourceReview; independent: SourceReview; packetSha256: string };
  target: { dataset: "co_sos" | "fmcsa"; recordId: string; sourceUrl: string; rowSha256: string; evidenceSha256: string;
    identitySha256: string; sourceRowSha256: string; factsSha256: string; sourceAsOf: string | null; observedAt: string };
  anchor: { mode: "address_role"; role: Role; sourceId: string } | { mode: "company_email_domain" };
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
export const registryOfficialApiCanonicalHash = registrySamCanonicalHash;
export function registryOfficialApiEvidenceHash(row: RegistryFinding, proof: Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">) {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId,
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail), evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
// Reviewed deployment data is the trust boundary; callers supply only its exact
// ID/hash and actual final witnesses. No caller-authored source transcription.
export function registryOfficialApiEntry(id: string) {
  const entries = catalog.entries as RegistryOfficialApiEntry[], matches = entries.filter(e => e.id === id);
  need(catalog.version === 1 && entries.length <= 1000 && matches.length === 1, "entry missing or ambiguous");
  return { entry: JSON.parse(JSON.stringify(matches[0])) as RegistryOfficialApiEntry, sha256: sha(stableRegistryJson(matches[0])) };
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
export function verifyRegistryOfficialApi(row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now = new Date()): NonNullable<RegistryProfile["verification"]> {
  const keys = ["schema", "entryId", "entrySha256", "canonicalIdentitySha256", "reader", "reviewer"];
  need(object(raw) && Object.keys(raw).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(raw, k)) && raw.schema === "official_api_roles_v1" && typeof raw.entryId === "string", "proof shape invalid");
  const { entry, sha256 } = registryOfficialApiEntry(raw.entryId), source = entry.source;
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
  const physical = verifyOriginal(row, entry, parsed), legal = row.profile.identity.legalName, dba = entry.sourceKind === "fmcsa_census" ? retainedFmcsaDba(row.profile) : null;
  const compatible = (name: string) => sameRegistryLegalName(name, legal) || !!dba && normalizedDba(name) === normalizedDba(dba);
  need(company.id === entry.companyId && row.companyId === entry.companyId && company.netsuite_internal_id === entry.internalId && row.internalId === entry.internalId
    && host(company.domain || company.website_raw || "") === entry.canonicalDomain && hash(entry.canonicalIdentitySha256)
    && raw.canonicalIdentitySha256 === entry.canonicalIdentitySha256 && raw.canonicalIdentitySha256 === registryOfficialApiCanonicalHash(company, context)
    && compatible(company.name) && context.aliases.every(compatible), "canonical identity or known legal operator conflict");
  let anchor: CompanyIdentityContext["addresses"][number] | null = null, roleAddress: Address | null = null, email: string | null = null;
  if (entry.anchor.mode === "address_role") {
    const role = entry.anchor;
    roleAddress = address(parsed, entry.sourceKind, role.role);
    const anchors = context.addresses.filter(a => a.sourceId === role.sourceId && ["netsuite_record", "company_website"].includes(a.sourceKind) && iso(a.capturedAt) && fullAddress(a, roleAddress!));
    need(anchors.length === 1, "complete canonical role anchor missing or ambiguous"); anchor = anchors[0];
  } else {
    need(entry.anchor.mode === "company_email_domain" && entry.sourceKind === "fmcsa_census", "contact anchor mode invalid");
    email = emailDomain(parsed.email_address);
    need(email && email === entry.canonicalDomain, "strict company email domain differs or is shared");
  }
  const { reader, reviewer, ...evidence } = raw, bound = registryOfficialApiEvidenceHash(row, evidence as Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">);
  const earliest = Math.max(Date.parse(row.profile.observedAt), Date.parse(source.observedAt), ...[...reviews, ...originals].map(a => Date.parse(a.reviewedAt)), anchor ? Date.parse(anchor.capturedAt) : 0);
  for (const witness of [reader, reviewer]) need(object(witness) && Object.keys(witness).every(k => ["taskId", "reviewedAt", "evidenceSha256"].includes(k)) && validTask(witness.taskId)
    && iso(witness.reviewedAt) && Date.parse(witness.reviewedAt) >= earliest && Date.parse(witness.reviewedAt) <= now.getTime() + 60000
    && now.getTime() - Date.parse(witness.reviewedAt) <= 7 * 86400000 && witness.evidenceSha256 === bound, "final review does not bind exact content");
  need((reader as Witness).taskId !== (reviewer as Witness).taskId && Date.parse((reviewer as Witness).reviewedAt) >= Date.parse((reader as Witness).reviewedAt), "distinct ordered final review required");
  return { method: "reviewed_official_registration_history", verifiedAt: now.toISOString(), sourceIds: [`${row.profile.dataset}:${row.profile.recordId}:${sha256}`, ...(anchor ? [anchor.sourceId] : [])],
    officialHistory: { ...evidence, reader, reviewer, evidenceSha256: bound, entry, canonicalAnchor: anchor, roleAddress, companyEmailDomain: email,
      targetAddress: { role: entry.sourceKind === "fmcsa_census" ? "carrier_physical" : "principal_street", ...physical },
      scope: "Reviewed official API entity/contact role association at the retained observation date. Original physical facts remain unchanged; mailing and registered-agent addresses are not operating locations. A declared company email domain does not establish current website ownership or contact permission." } };
}
