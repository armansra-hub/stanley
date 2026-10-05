import { createHash } from "node:crypto";
import { parseCsv } from "@/lib/csv";
import type { CompanyIdentityContext, CrmDomainReference } from "@/lib/companyIdentity";
import { STATE_NAMES } from "@/lib/publicGrowth/identity";
import { sameCompanySite } from "@/lib/sources/siteDiscovery";
import { extractCompanyIdentity } from "@/lib/sources/siteContent";
import { fetchPublicHttpText, validatePublicHttpUrl, type PublicHttpTextResponse } from "@/lib/triggers/urlSafety";
import { registryContentHash, retainedFmcsaDba, normalizedDba, registryStreet, sameRegistryLegalName, sameRegistryStreet, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";

import { registryWebsiteText, registryWebsiteQuoteOutsideWidget, type RegistryWebsiteNormalization } from "./registryWebsiteText";

type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
export type RegistryWebsiteCorroboration = {
  crmDomainReference?: CrmDomainReference;
  normalization?: RegistryWebsiteNormalization;
  // Reviewed canonical-root delegation; it never substitutes for entity/address evidence.
  canonicalRedirect?: { requestedUrl: string; finalUrl: string; normalizedVisibleTextSha256: string };
  mode?: "registry_identifier" | "registry_dba_address" | "site_operator_address";
  // Explicit own-site legal/DBA definition, distinct from the contact page and
  // never represented as a registry DBA or a changed canonical alias.
  observedAt?: string;
  operatorPage?: {
    schema: "explicit_site_operator_dba_definition_v1";
    sourceUrl: string; normalizedVisibleTextSha256: string; quote: string; quoteSha256: string;
    legalOperator: string; observedAt: string;
  };
  // An explicit definition on this same page; never a new canonical alias.
  operatorRelationship?: {
    schema: "explicit_site_operator_dba_definition_v1";
    legalOperator: string; canonicalSubject: string; quote: string; quoteSha256: string;
  };
  identifier?: { kind: "usdot" | "ein" | "cslb_license" | "cra_charity_registration"; value: string };
  sourceUrl: string; normalizedVisibleTextSha256: string; quote: string; quoteSha256: string; subject: string;
  // Omission is accepted only for an exact ca_contractors / cslb_license proof.
  // It means the website address is unknown, never borrowed from the registry.
  address?: Omit<RegistryProfile["identity"], "legalName"> & { city: string; countryCode: "US" | "CA" };
  reader: Attestation; reviewer: Attestation;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));

export type RegistryWebsiteAvailabilityDiagnostic = {
  schema: "registry_website_availability_v1";
  sourceUrl: string | null; finalUrl: string | null;
  status: number | null; contentType: string | null;
  errorClass: "http_status" | "content_type" | "unsafe_target" | "timeout" | "size_limit"
    | "content_decoding" | "dns_error" | "tls_error" | "connection_error" | "transport_error";
};

function diagnosticPublicUrl(raw: string): string | null {
  try {
    const url = validatePublicHttpUrl(raw);
    url.search = ""; url.hash = "";
    return url.href.length <= 2000 ? url.href : null;
  } catch { return null; }
}

function transportErrorClass(error: unknown): RegistryWebsiteAvailabilityDiagnostic["errorClass"] {
  if (!(error instanceof Error)) return "transport_error";
  // Fixed categories only: never reflect arbitrary Node error messages, causes,
  // host/IP details, headers, or properties supplied by a remote server.
  if (error.name === "UnsafeHttpTargetError") return "unsafe_target";
  if (["HTTP fetch timed out", "HTTP verification timed out"].includes(error.message)) return "timeout";
  if (["HTTP response exceeded size limit", "HTTP decoded response exceeded size limit"].includes(error.message)) return "size_limit";
  if (["Unsupported HTTP content encoding", "HTTP response content decoding failed"].includes(error.message)) return "content_decoding";
  const code = "code" in error ? error.code : null;
  if (["ENOTFOUND", "EAI_AGAIN", "ENODATA", "ESERVFAIL"].includes(String(code))) return "dns_error";
  if (["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"].includes(String(code))) return "tls_error";
  if (code === "ETIMEDOUT") return "timeout";
  if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"].includes(String(code))) return "connection_error";
  return "transport_error";
}

/** Metadata from the failed public fetch only. Missing response metadata stays
 * unknown; no second request, response body, private context, or acceptance change. */
export class RegistryWebsiteAvailabilityError extends Error {
  readonly diagnostic: RegistryWebsiteAvailabilityDiagnostic;
  constructor(sourceUrl: string, failure: { page: PublicHttpTextResponse } | { error: unknown }) {
    super("page" in failure ? "registry website full HTML unavailable" : "registry website source unavailable");
    this.name = "RegistryWebsiteAvailabilityError";
    const page = "page" in failure ? failure.page : null;
    const mime = page?.contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
    this.diagnostic = {
      schema: "registry_website_availability_v1", sourceUrl: diagnosticPublicUrl(sourceUrl),
      finalUrl: page ? diagnosticPublicUrl(page.finalUrl) : null,
      status: page && Number.isInteger(page.status) && page.status >= 100 && page.status <= 599 ? page.status : null,
      contentType: mime.length <= 127 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : null,
      errorClass: page ? page.status !== 200 ? "http_status" : "content_type" : transportErrorClass("error" in failure ? failure.error : null),
    };
  }
}


const MAX_WEBSITE_SOURCE_BYTES = 2_000_000;
export type RegistryWebsiteMismatchDiagnostic = {
  schema: "registry_website_mismatch_v1";
  sourceUrl: string; finalUrl: string; fetchedAt: string; deploymentCommit: string | null;
  normalization: RegistryWebsiteNormalization | "legacy_html_to_visible_text";
  expectedNormalizedVisibleTextSha256: string; observedNormalizedVisibleTextSha256: string;
  htmlSha256: string; htmlUtf8Bytes: number; normalizedCharacters: number; normalizedUtf8Bytes: number;
  expectedQuoteSha256: string; quotePresent: boolean; quoteStart: number;
  status: number; contentType: string | null;
  snapshot: { complete: true; rawHtml: string; normalizedText: string }
    | { complete: false; omittedReason: "serialized_diagnostic_exceeds_byte_cap" };
  diagnosticByteCap: number;
};

/** Public fetched evidence only; never request headers, credentials or CRM context.
 * A rejected fetch remains rejected. The authenticated route retains this exact
 * response in its ordinary local receipt, without a speculative second fetch.
 */
export class RegistryWebsiteMismatchError extends Error {
  readonly diagnostic: RegistryWebsiteMismatchDiagnostic;
  constructor(page: PublicHttpTextResponse, proof: RegistryWebsiteCorroboration, visibleText: string, fetchedAt: string) {
    super("registry website changed or exact reviewed quote missing");
    this.name = "RegistryWebsiteMismatchError";
    const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? "";
    const quoteStart = visibleText.indexOf(proof.quote);
    const metadata = {
      schema: "registry_website_mismatch_v1" as const,
      sourceUrl: proof.sourceUrl, finalUrl: page.finalUrl, fetchedAt,
      deploymentCommit: /^[a-f0-9]{40}$/.test(commit) ? commit : null,
      normalization: proof.normalization ?? "legacy_html_to_visible_text" as const,
      expectedNormalizedVisibleTextSha256: proof.normalizedVisibleTextSha256,
      observedNormalizedVisibleTextSha256: sha(visibleText), htmlSha256: sha(page.body),
      htmlUtf8Bytes: Buffer.byteLength(page.body, "utf8"), normalizedCharacters: visibleText.length,
      normalizedUtf8Bytes: Buffer.byteLength(visibleText, "utf8"), expectedQuoteSha256: proof.quoteSha256,
      quotePresent: quoteStart >= 0, quoteStart, status: page.status, contentType: page.contentType,
      diagnosticByteCap: MAX_WEBSITE_SOURCE_BYTES,
    };
    const complete = { ...metadata, snapshot: { complete: true as const, rawHtml: page.body, normalizedText: visibleText } };
    // The cap is on actual serialized UTF-8 bytes (including JSON escapes), not
    // character count. Omit both bodies together; never label a prefix complete.
    this.diagnostic = Buffer.byteLength(JSON.stringify(complete), "utf8") <= MAX_WEBSITE_SOURCE_BYTES ? complete
      : { ...metadata, snapshot: { complete: false, omittedReason: "serialized_diagnostic_exceeds_byte_cap" } };
  }
}

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const contains = (quote: string, value: string) => (` ${words(quote)} `).includes(` ${words(value)} `);
const stateNames = new Map(STATE_NAMES.split("|").map(entry => { const [name, code] = entry.split(":"); return [code, name]; }));

/** Both actual tasks attest that they read this exact passage in its page context
 * and attributed any provided address and registry identifier to this legal entity.
 * Mailing/HQ/physical roles remain in the exact quote. Identifier mode preserves
 * both addresses as separate observations; it does not establish their equivalence.
 * Distinct task IDs document review separation; they are not cryptographic proof
 * of different people. Authentication remains the existing agent bridge gate. */
export function registryWebsiteEvidenceHash(row: Pick<RegistryFinding, "companyId" | "internalId" | "profile"> & Partial<Pick<RegistryFinding, "sourceUrl" | "detail" | "evidence">>,
  proof: Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">): string {
  const legacy = { companyId: row.companyId, internalId: row.internalId, dataset: row.profile.dataset,
    recordId: row.profile.recordId, rowSha256: row.profile.provenance.rowSha256, ...proof };
  if (proof.mode !== "registry_identifier" && proof.mode !== "registry_dba_address" && proof.mode !== "site_operator_address" && !proof.canonicalRedirect && !proof.crmDomainReference) return sha(stableRegistryJson(legacy));
  // Existing address-mode callers may pass a narrow row. Explicit new modes must
  // bind the entire parsed publication content, not trust an unchanged row ID/hash.
  if (typeof row.sourceUrl !== "string" || !row.sourceUrl || typeof row.evidence !== "string" || !row.evidence
    || row.detail !== null && typeof row.detail !== "string"
    || typeof row.profile.observedAt !== "string" || !Number.isFinite(Date.parse(row.profile.observedAt)))
    throw new Error("registry website bound evidence requires complete parsed publication content");
  return sha(stableRegistryJson({ ...legacy, [proof.mode === "registry_identifier" ? "identifierContent" : proof.mode === "registry_dba_address" ? "dbaContent" : proof.mode === "site_operator_address" ? "operatorContent" : proof.crmDomainReference ? "crmContent" : "redirectContent"]: {
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt,
  } }));
}

export function parseRegistryWebsiteCorroboration(raw: unknown, row: RegistryFinding, now = new Date()): RegistryWebsiteCorroboration {
  if (!object(raw) || Object.keys(raw).some(k => !["sourceUrl", "normalizedVisibleTextSha256", "quote", "quoteSha256", "subject", "address", "reader", "reviewer", "mode", "identifier", "normalization", "canonicalRedirect", "operatorRelationship", "observedAt", "operatorPage", "crmDomainReference"].includes(k))
    || !text(raw.sourceUrl, 2000) || !text(raw.quote, raw.canonicalRedirect !== undefined && raw.mode === undefined ? 6000 : 1800) || raw.quote.length < 20 || !text(raw.subject, 200)
    || !hash(raw.normalizedVisibleTextSha256) || !hash(raw.quoteSha256) || sha(raw.quote) !== raw.quoteSha256)
    throw new Error("invalid registry website evidence");
  if (raw.mode !== undefined && raw.mode !== "registry_identifier" && raw.mode !== "registry_dba_address" && raw.mode !== "site_operator_address" || raw.mode !== "registry_identifier" && raw.identifier !== undefined)
    throw new Error("invalid registry website mode");
  if (raw.crmDomainReference !== undefined) {
    const ref = raw.crmDomainReference;
    if ((raw.mode !== undefined && raw.mode !== "registry_dba_address") || raw.canonicalRedirect !== undefined || raw.operatorRelationship !== undefined
      || !sourceTime(raw.observedAt) || !object(ref)
      || Object.keys(ref).sort().join(",") !== "capturedAt,companyId,companyName,domain,headerSha256,internalId,recordId,schema"
      || ref.schema !== "netsuite_provisioning_email_domain_v1" || ref.companyId !== row.companyId || ref.internalId !== row.internalId
      || typeof ref.recordId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ref.recordId)
      || !text(ref.companyName, 200) || !text(ref.domain, 253) || !/^[a-z0-9.-]+$/.test(ref.domain)
      || !hash(ref.headerSha256) || !sourceTime(ref.capturedAt))
      throw new Error("invalid registry website CRM domain reference");
  }
  if (raw.mode === "site_operator_address") {
    const op = raw.operatorPage;
    if (!object(op) || Object.keys(op).some(k => !["schema", "sourceUrl", "normalizedVisibleTextSha256", "quote", "quoteSha256", "legalOperator", "observedAt"].includes(k))
      || op.schema !== "explicit_site_operator_dba_definition_v1" || !text(op.sourceUrl, 2000)
      || !hash(op.normalizedVisibleTextSha256) || !text(op.quote, 900) || !hash(op.quoteSha256) || sha(op.quote) !== op.quoteSha256
      || !text(op.legalOperator, 200) || !sourceTime(op.observedAt) || !sourceTime(raw.observedAt)
      || raw.normalization !== undefined || raw.canonicalRedirect !== undefined || raw.operatorRelationship !== undefined
      || op.sourceUrl === raw.sourceUrl)
      throw new Error("invalid two-page website operator evidence");
  } else if (raw.operatorPage !== undefined || raw.observedAt !== undefined && raw.crmDomainReference === undefined) throw new Error("operator pages require explicit two-page mode");
  if (raw.operatorRelationship !== undefined) {
    const relation = raw.operatorRelationship;
    if (raw.mode !== "registry_dba_address" || !object(relation)
      || Object.keys(relation).some(k => !["schema", "legalOperator", "canonicalSubject", "quote", "quoteSha256"].includes(k))
      || relation.schema !== "explicit_site_operator_dba_definition_v1"
      || !text(relation.legalOperator, 200) || !text(relation.canonicalSubject, 200)
      || !text(relation.quote, 650) || !hash(relation.quoteSha256) || sha(relation.quote) !== relation.quoteSha256)
      throw new Error("invalid registry website operator relationship");
  }
  if (raw.normalization !== undefined && raw.normalization !== "gravity_forms_honeypot_v1" && raw.normalization !== "gravity_forms_honeypot_v2" && raw.normalization !== "gravity_forms_honeypot_v3" && raw.normalization !== "everest_forms_honeypot_v1" && raw.normalization !== "everest_forms_honeypot_v2" && raw.normalization !== "everest_forms_honeypot_v3" && raw.normalization !== "testimonials_widget_unordered_v1")
    throw new Error("invalid registry website normalization");
  // The unordered-widget mode supports ordinary complete legal-name/address
  // proofs only; identifier, DBA and redirect grammars retain their own gates.
  if (raw.normalization === "testimonials_widget_unordered_v1" && (raw.mode !== undefined || raw.canonicalRedirect !== undefined))
    throw new Error("unordered testimonials normalization requires an ordinary address proof");
  if (raw.canonicalRedirect !== undefined) {
    const redirect = raw.canonicalRedirect;
    if (!object(redirect) || Object.keys(redirect).some(k => !["requestedUrl", "finalUrl", "normalizedVisibleTextSha256"].includes(k))
      || !text(redirect.requestedUrl, 2000) || !text(redirect.finalUrl, 2000) || !hash(redirect.normalizedVisibleTextSha256))
      throw new Error("invalid registry website canonical redirect");
    const requested = publicRootUrl(redirect.requestedUrl), final = publicRootUrl(redirect.finalUrl);
    if (requested === final) throw new Error("registry website canonical redirect must change its root URL");
  }
  const identifier = raw.mode === "registry_identifier" ? identifierRule(row, raw.identifier) : undefined;
  const a = raw.address;
  if (!(a === undefined && identifier?.kind === "cslb_license") && (!object(a)
    || Object.keys(a).some(k => !["addressLine1", "addressLine2", "city", "state", "postalCode", "countryCode"].includes(k))
    || !["addressLine1", "city", "state", "postalCode"].every(k => text(a[k], 200))
    || a.addressLine2 !== undefined && !text(a.addressLine2, 200) || !["US", "CA"].includes(String(a.countryCode))))
    throw new Error("invalid registry website address");
  const { reader, reviewer, ...evidence } = raw;
  const evidenceSha256 = registryWebsiteEvidenceHash(row, evidence as Omit<RegistryWebsiteCorroboration, "reader" | "reviewer">);
  for (const attestation of [reader, reviewer]) {
    if (!object(attestation) || Object.keys(attestation).some(k => !["taskId", "reviewedAt", "evidenceSha256"].includes(k))
      || !text(attestation.taskId, 160) || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(attestation.taskId)
      || typeof attestation.reviewedAt !== "string" || !/T.+(?:Z|[+-]\d{2}:\d{2})$/.test(attestation.reviewedAt)
      || !Number.isFinite(Date.parse(attestation.reviewedAt)) || Date.parse(attestation.reviewedAt) > now.getTime() + 60_000
      || now.getTime() - Date.parse(attestation.reviewedAt) > 7 * 86_400_000 || attestation.evidenceSha256 !== evidenceSha256)
      throw new Error("registry website review does not bind exact current evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("registry website requires independent review");
  if (raw.mode === "site_operator_address") {
    const op = raw.operatorPage as NonNullable<RegistryWebsiteCorroboration["operatorPage"]>;
    const earliest = Math.max(Date.parse(raw.observedAt as string), Date.parse(op.observedAt), Date.parse(row.profile.observedAt));
    if (Date.parse((reader as Attestation).reviewedAt) < earliest || Date.parse((reviewer as Attestation).reviewedAt) < Date.parse((reader as Attestation).reviewedAt))
      throw new Error("two-page website review precedes its complete sources");
  }
  if (raw.crmDomainReference !== undefined) {
    const ref = raw.crmDomainReference as CrmDomainReference;
    const earliest = Math.max(Date.parse(ref.capturedAt), Date.parse(raw.observedAt as string), Date.parse(row.profile.observedAt));
    if (Date.parse((reader as Attestation).reviewedAt) < earliest || Date.parse((reviewer as Attestation).reviewedAt) < Date.parse((reader as Attestation).reviewedAt))
      throw new Error("registry website CRM review precedes its complete sources");
  }
  return raw as RegistryWebsiteCorroboration;
}


type Identifier = NonNullable<RegistryWebsiteCorroboration["identifier"]>;
/** CRA's charity account is the whole BN + RR + account suffix. The fiscal
 * suffix identifies this exact financial record, not the charity's current status.
 * Bind the two retained original CSV rows; never borrow the website office address. */
function craIdentifierRule(row: RegistryFinding, value: string) {
  const p = row.profile, source = p.provenance.sourceRow, authority = validatePublicHttpUrl(row.sourceUrl);
  const period = p.recordId.match(/^([0-9]{9}RR[0-9]{4}):([0-9]{4}-[0-9]{2}-[0-9]{2})$/)?.[2];
  const facts = (field: string, expected: string) => p.facts.filter(f => f.field === field).length === 1
    && p.facts.some(f => f.field === field && f.value === expected) && source[field] === expected;
  const original = row.evidence.match(/^([^\r\n]+)(\r?\n)([^\r\n]+)(\r?\n)$/), rows = parseCsv(row.evidence);
  const identity = rows[0], financial = rows[1];
  if (p.dataset !== "cra_charities" || !/^[0-9]{9}RR[0-9]{4}$/.test(value)
    || authority.protocol !== "https:" || authority.hostname !== "open.canada.ca"
    || authority.username || authority.password || authority.port
    || !period || p.recordId !== value + ":" + period || !Number.isFinite(Date.parse(period))
    || new Date(period).toISOString().slice(0, 10) !== period || p.sourceAsOf !== period
    || !facts("registration_number", value) || !facts("tax_period", period)
    || p.identity.countryCode !== "CA" || source.countryCode !== "CA"
    || !/^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/.test(p.identity.state)
    || !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(p.identity.postalCode)
    || !original || sha(original[3] + original[4]) !== p.provenance.rowSha256 || p.provenance.quote !== row.evidence
    || rows.length !== 2 || identity?.length !== 12 || financial?.length < 3
    || identity[0] !== value || financial[0] !== value || financial[1] !== period
    || identity[4] !== p.identity.legalName || identity[6] !== p.identity.addressLine1
    || identity[7] !== (p.identity.addressLine2 ?? "") || identity[8] !== p.identity.city
    || identity[9] !== p.identity.state || identity[10] !== p.identity.postalCode || identity[11] !== "CA")
    throw new Error("registry website CRA identifier does not bind exact Canadian source rows and fiscal record");
}
function identifierRule(row: RegistryFinding, identifier: unknown): Identifier {
  if (!object(identifier) || Object.keys(identifier).some(k => !["kind", "value"].includes(k))
    || !text(identifier.value, identifier.kind === "cra_charity_registration" ? 15 : 12)) throw new Error("invalid registry website identifier");
  if (identifier.kind === "cra_charity_registration") {
    craIdentifierRule(row, identifier.value);
    return identifier as Identifier;
  }
  const isDot = row.profile.dataset === "fmcsa" && identifier.kind === "usdot";
  const isEin = row.profile.dataset === "irs_exempt" && identifier.kind === "ein";
  const isCslb = row.profile.dataset === "ca_contractors" && identifier.kind === "cslb_license";
  if (isCslb) {
    const authority = validatePublicHttpUrl(row.sourceUrl);
    if (authority.protocol !== "https:" || !["cslb.ca.gov", "web.cslb.ca.gov"].includes(authority.hostname.replace(/^www\./, "")))
      throw new Error("registry website license requires the California CSLB source authority");
  }
  const field = isDot ? "usdot_number" : isCslb ? "license_number" : "ein", value = identifier.value;
  const facts = row.profile.facts.filter(f => f.field === field);
  if ((!isDot && !isEin && !isCslb) || !(isDot ? /^[1-9]\d{3,8}$/ : isCslb ? /^[1-9]\d{0,7}$/ : /^\d{9}$/).test(value)
    || row.profile.recordId !== value || String(row.profile.provenance.sourceRow[field]) !== value
    || (isCslb ? facts.length !== 1 || String(facts[0].value) !== value : facts.filter(f => String(f.value) === value).length !== 1)
    || (row.profile.identity.countryCode ?? "US") !== "US")
    throw new Error("registry website identifier does not bind exact source dataset, record and fact");
  return identifier as Identifier;
}
function labelledIdentifiers(value: string, kind: Identifier["kind"]) {
  // Closed public labels. A generic number, phone, MC number or tax deduction is not an ID.
  const re = kind === "cra_charity_registration"
    ? /\b(?:charitable|charity)\s+registration\s+(?:number|no\.?)\s*[:#]?\s*(\d+[ \u00a0]*(?:[a-z]{2}[ \u00a0]*)?\d*[a-z0-9_/-]*(?:\.\d+)*)(?![a-z0-9])/gi
    : kind === "usdot"
    ? /\b(?:USDOT|US\s+DOT|U\.S\.\s*DOT|DOT)\s*(?:(?:number|no\.?)\s*)?(?::\s*#?|#)?\s*([1-9]\d{3,8})(?![a-z0-9])/gi
    : kind === "cslb_license"
      ? /\b(?:CSLB(?:\s+(?:contractor(?:'s)?\s+)?license)?|(?:California|CA)\s+(?:contractor(?:'s)?\s+)?license|Licenses?\s*:\s*CA\s*-)\s*(?:(?:number|no\.?)\s*)?[:#]?\s*(\d+[a-z0-9_/-]*(?:\.\d+)*)/gi
      : /\b(?:EIN|Employer Identification Number|Federal Tax (?:ID|Identification Number))\s*(?:(?:number|no\.?)\s*)?[:#]?\s*(\d{2}-?\d{7})(?![a-z0-9])/gi;
  // Retain malformed CSLB tokens too: a second labelled 0644768 or 644768-X
  // is conflicting evidence, not an alias that can be silently discarded.
  return [...value.matchAll(re)].map(m => ({ value: kind === "cra_charity_registration" ? m[1].replace(/[ \u00a0]/g, "") : kind === "ein" ? m[1].replace(/-/g, "") : m[1], start: m.index!, end: m.index! + m[0].length }));
}
function legalParts(value: string) {
  const normalized = words(value).replace(/\b(l l c|l l p|p l l c|l p|p c)$/, suffix => suffix.replace(/ /g, ""));
  const suffix = normalized.match(/\s+(incorporated|inc|corporation|corp|limited|ltd|llc|llp|pllc|lp|pc)$/);
  const equivalents: Record<string, string> = { incorporated: "inc", corporation: "corp", limited: "ltd" };
  return { core: suffix ? normalized.slice(0, suffix.index) : normalized, suffix: suffix ? equivalents[suffix[1]] ?? suffix[1] : null };
}
function sameLimitedCompanySubject(left: string, right: string): boolean {
  // Only Company/Co immediately before the same explicit Limited/Ltd form.
  // The caller restricts this alternative to complete US address-mode proofs.
  const a = legalParts(left), b = legalParts(right);
  if (a.suffix !== "ltd" || b.suffix !== "ltd") return false;
  const x = a.core.match(/^(.+) (company|co)$/), y = b.core.match(/^(.+) (company|co)$/);
  return Boolean(x && y && x[1] === y[1] && x[2] !== y[2]);
}
function samePossessiveWebsiteSubject(left: string, right: string): boolean {
  // One internal possessive apostrophe is punctuation, not a removed letter or
  // an alias. The caller requires an existing canonical/legal-name agreement
  // and the same complete US source address. Never used in ID or DBA modes.
  const fold = (value: string) => {
    const name = value.normalize("NFKC");
    const marks = name.match(/['’]/g) ?? [];
    if (!marks.length) return name;
    if (marks.length !== 1 || !/\b[a-z]{2,}['’]s\b/i.test(name)) return null;
    return name.replace(/(\b[a-z]{2,})['’](s\b)/i, "$1$2");
  };
  const a = fold(left), b = fold(right);
  return a !== null && b !== null && (a !== left || b !== right) && sameRegistryLegalName(a, b);
}
type SubjectSpan = { start: number; end: number; definitionEnd: number };
function separateContactHeadingSubjects(html: string, visibleText: string, subject: string, normalization?: RegistryWebsiteNormalization): Set<number> {
  // Bind the exception to this exact visible occurrence and separate headings.
  // Inline words, another occurrence and unrelated headings grant no exception.
  const source = html.replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), positions = new Set<number>();
  for (const heading of source.matchAll(/<h([1-6])\b[^>]*>\s*Contact\s+Us\s*<\/h\1\s*>/gi)) {
    const end = heading.index! + heading[0].length;
    const next = source.slice(end).match(new RegExp("^(?:\\s|<\\/?(?:div|section|article|header)\\b[^>]*>)*<h([1-6])\\b[^>]*>\\s*(" + escaped + ")(?:\\.)?\\s*<\\/h\\1\\s*>", "i"));
    if (!next) continue;
    const prefix = registryWebsiteText(source.slice(0, end), normalization), at = prefix.length + (prefix ? 1 : 0);
    if (visibleText.slice(0, prefix.length) === prefix
      && visibleText.slice(at, at + subject.length).toLowerCase() === subject.toLowerCase()) positions.add(at);
  }
  return positions;
}
function exactSubjectPositions(value: string, subject: string, cslbAreaHeading = false, dbaNavigation = false, relationshipDba?: SubjectSpan, contactHeadings?: true | ReadonlySet<number>): number[] {
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...value.matchAll(new RegExp(escaped, "giu"))];
  if (!matches.length) throw new Error("registry identifier full legal subject is missing");
  for (const match of matches) {
    const at = match.index!, end = at + match[0].length;
    if (/[\p{L}\p{N}_'’&-]/u.test(value[at - 1] ?? "") || /[\p{L}\p{N}_'’&-]/u.test(value[end] ?? ""))
      throw new Error("registry identifier legal subject lacks exact token boundaries");
    const before = value.slice(Math.max(0, at - 120), at), after = value.slice(end, end + 120);
    const clause = before.split(/[.!?;\n]/).at(-1) ?? "";
    if (/\b(?:not|never|neither|unrelated|no (?:affiliation|association|connection|relationship))\b/i.test(clause)
      || /^\s*(?:(?:is|are|was|were)\s+)?(?:not|never|unrelated)\b/i.test(after))
      throw new Error("registry identifier legal subject is negated or unrelated");
    // A leading word can be part of a different legal name ('Global Acme Inc').
    // Only closed, neutral sentence/header connectors are accepted here. This
    // conservative guard is not a parser or a substitute for both full readers.
    const prefix = before.match(/([\p{L}][\p{L}'’&-]*)\s+$/u)?.[1];
    // A complete, neutral website heading is not part of the contractor's name.
    // This allowance belongs only to the CSLB mode; 'Served' alone, embedded
    // heading words, negated names and other occurrences still fail the guards.
    const neutralAreaHeading = cslbAreaHeading && /(?:^|[^\p{L}\p{N}_'’&-])Additional Areas Served\s+$/u.test(before);
    const neutralDbaNavigation = dbaNavigation && /(?:^|[^\p{L}\p{N}_])Skip to content\s+$/u.test(before);
    const definedDba = relationshipDba?.start === at && relationshipDba.end === end;
    const neutralContactHeading = /(?:^|[^\p{L}\p{N}_'’&-])Contact Us\s+$/u.test(before)
      && (contactHeadings === true || contactHeadings?.has(at));
    if (prefix && !definedDba && !neutralAreaHeading && !neutralDbaNavigation && !neutralContactHeading && !/^(?:about|contact|copyright|name|legal|company|to|by|is|are|of)$/i.test(prefix))
      throw new Error("registry identifier legal subject has an ambiguous name prefix");
  }
  return matches.map(match => match.index!);
}
function identifierAttribution(row: RegistryFinding, proof: RegistryWebsiteCorroboration, visibleText: string, contactHeadings?: true | ReadonlySet<number>) {
  const identifier = identifierRule(row, proof.identifier), quoteIds = labelledIdentifiers(proof.quote, identifier.kind);
  const pageIds = labelledIdentifiers(visibleText, identifier.kind);
  if (!quoteIds.length || !pageIds.length || pageIds.some(id => id.value !== identifier.value)
    || quoteIds.some(id => id.value !== identifier.value))
    throw new Error("registry website labelled identifier is missing or conflicting");
  const legal = legalParts(row.profile.identity.legalName), subject = legalParts(proof.subject);
  // New mode requires an explicit matching legal form when the source has one.
  if (legal.core !== subject.core || legal.suffix && legal.suffix !== subject.suffix)
    throw new Error("registry identifier requires the exact full legal subject");
  const normalized = " " + words(visibleText).replace(/\b(l l c|l l p|p l l c|l p|p c)\b/g, suffix => suffix.replace(/ /g, "")) + " ";
  for (const suffix of ["incorporated", "inc", "corporation", "corp", "limited", "ltd", "llc", "llp", "pllc", "lp", "pc"]) {
    const candidate = legalParts(legal.core + " " + suffix);
    if (normalized.includes(" " + legal.core + " " + suffix + " ") && candidate.suffix !== (legal.suffix ?? subject.suffix))
      throw new Error("registry website has conflicting legal forms");
  }
  // A selected passage containing relationship or historic ownership ambiguity is held.
  if (/\b(customer|client|partner|affiliate|subsidiar(?:y|ies)|parent company|third[ -]party|on behalf of|formerly|previously|former|previous|old (?:DOT|USDOT|EIN))\b/i.test(proof.quote))
    throw new Error("registry website identifier attribution is ambiguous");
  const cslbHistoricalOrNegated = /\b(?:(?:old|former|previous|not (?:our|the))\s+(?:CSLB|California|CA|contractor|licenses?)|(?:not|never)\s+(?:CSLB|California|CA)\b|(?:do|does) not (?:hold|own|use)|no longer (?:hold|own|use))\b/i;
  if (identifier.kind === "cslb_license" && cslbHistoricalOrNegated.test(proof.quote))
    throw new Error("registry website license attribution is historical or negated");
  const craHistoricalOrNegated = /\b(?:(?:old|former|previous|not (?:our|the))\s+(?:CRA|charitable|charity)|(?:not|never)\s+(?:our\s+)?(?:charitable|charity)\b|(?:do|does) not (?:hold|own|use)|no longer (?:hold|own|use))\b/i;
  if (identifier.kind === "cra_charity_registration" && craHistoricalOrNegated.test(proof.quote))
    throw new Error("registry website charity attribution is historical or negated");
  const headings = identifier.kind === "usdot" ? contactHeadings : undefined;
  const quoteStart = visibleText.indexOf(proof.quote);
  const quoteHeadings = headings === true ? true : headings && new Set([...headings].map(at => at - quoteStart));
  const subjects = exactSubjectPositions(proof.quote, proof.subject, identifier.kind === "cslb_license", false, undefined, quoteHeadings);
  exactSubjectPositions(visibleText, proof.subject, identifier.kind === "cslb_license", false, undefined, headings);
  if (!subjects.some(subjectAt => quoteIds.some(id => Math.min(Math.abs(id.start - subjectAt), Math.abs(id.end - (subjectAt + proof.subject.length))) <= 650)))
    throw new Error("registry website identifier is not beside its legal subject");
  // Do not borrow the same number from a customer/carrier reference elsewhere on the page.
  for (const id of pageIds) {
    const vicinity = visibleText.slice(Math.max(0, id.start - 100), Math.min(visibleText.length, id.end + 100));
    if (/\b(?:(?:customer|client|partner|affiliate|subsidiary|parent company|third[ -]party|other carrier|another carrier)(?:'s|’s)?|belongs to|licensed to|on behalf of|former (?:DOT|USDOT|EIN)|previous (?:DOT|USDOT|EIN)|old (?:DOT|USDOT|EIN)|not (?:our|the) (?:DOT|USDOT|EIN)|does not (?:belong|identify)|not assigned)\b/i.test(vicinity))
      throw new Error("registry website identifier has an ambiguous surrounding reference");
    if (identifier.kind === "cslb_license" && cslbHistoricalOrNegated.test(vicinity))
      throw new Error("registry website license attribution is historical or negated");
    if (identifier.kind === "cra_charity_registration" && craHistoricalOrNegated.test(vicinity))
      throw new Error("registry website charity attribution is historical or negated");
  }
}

/** Only the original, hash-verified FMCSA DBA can name this website subject.
 * This is a separate address proof, not a new canonical alias/address. */
function dbaSubject(row: RegistryFinding, proof: RegistryWebsiteCorroboration, companyName: string, aliases: string[]): string {
  const dba = retainedFmcsaDba(row.profile), legal = row.profile.identity.legalName;
  const relation = proof.operatorRelationship;
  if (!dba || normalizedDba(dba) !== normalizedDba(proof.subject)
    || !(relation ? normalizedDba(relation.canonicalSubject) === normalizedDba(companyName)
      && normalizedDba(relation.legalOperator) === normalizedDba(legal)
      : normalizedDba(companyName) === normalizedDba(dba) || sameRegistryLegalName(companyName, legal))
    || !aliases.every(alias => normalizedDba(alias) === normalizedDba(dba) || normalizedDba(alias) === normalizedDba(legal)))
    throw new Error("registry website DBA does not bind original operator and whole canonical name");
  return dba;
}
/** Closed present-tense site-operator statement, with an explicit quoted name
 * definition. The full address remains in the other independently bound quote.
 * This yields one occurrence exemption, never text replacement or a page join. */
function operatorRelationshipSpan(proof: RegistryWebsiteCorroboration, visibleText: string, domain: string): SubjectSpan | undefined {
  const relation = proof.operatorRelationship;
  if (!relation) return undefined;
  const start = visibleText.indexOf(relation.quote);
  if (start < 0 || visibleText.lastIndexOf(relation.quote) !== start
    || /[\p{L}\p{N}_'’&-]/u.test(visibleText[start - 1] ?? ""))
    throw new Error("registry website operator relationship is missing or duplicated");
  const prefix = "These Terms of Use govern your access to and use of the website located at ";
  const delimiter = ' (the "Site"), operated by ';
  const at = relation.quote.indexOf(delimiter), host = relation.quote.slice(prefix.length, at);
  const expected = `${prefix}${host}${delimiter}${relation.legalOperator} doing business as ${proof.subject} ("${relation.canonicalSubject}," "we," "us," or "our").`;
  if (!relation.quote.startsWith(prefix) || at <= prefix.length || !/^[a-z0-9.-]+$/i.test(host)
    || relation.quote !== expected || /\b(not|never|formerly|previously|former|previous|customer|client|partner|affiliate|subsidiary|parent|registered agent)\b/i.test(relation.quote))
    throw new Error("registry website operator relationship is not an explicit complete definition");
  ownUrl(`https://${host}/`, domain);
  const before = visibleText.slice(Math.max(0, start - 160), start);
  if (/\b(not|never|unrelated|customer|client|partner|affiliate|subsidiary|parent|third[ -]party|former|previous|example|sample|fictional|hypothetical)\b/i.test(before))
    throw new Error("registry website operator relationship context is ambiguous");
  // Only this explicit definition receives an occurrence exemption. Adjacent
  // operator/ownership contradictions remain disqualifying, while ordinary
  // user-agreement conditions ("if you do not agree") are not identity claims.
  const after = visibleText.slice(start + relation.quote.length, start + relation.quote.length + 200);
  if (/\b(?:operated|owned|managed|controlled)\s+by\b/i.test(after)
    || /\b(?:operator|relationship|definition|statement|identity|affiliation|dba)\b[^.!?]{0,80}\b(?:not|never|no longer|former|previous|outdated|obsolete|invalid|false|expired|historical)\b/i.test(after)
    || /\b(?:not|never|no longer|former|previous|outdated|obsolete|invalid|false|expired|historical)\b[^.!?]{0,80}\b(?:operator|relationship|definition|statement|identity|affiliation|dba)\b/i.test(after)
    || /\b(?:this|that|above|preceding)\s+(?:is|was)\s+(?:not|no longer|never|false|outdated|obsolete|invalid)\b/i.test(after))
    throw new Error("registry website operator relationship has contradictory following context");
  exactSubjectPositions(visibleText, relation.legalOperator);
  const legal = legalParts(relation.legalOperator), normalized = ` ${words(visibleText)} `;
  for (const suffix of ["incorporated", "inc", "corporation", "corp", "limited", "ltd", "llc", "llp", "pllc", "lp", "pc"])
    if (legalParts(`${legal.core} ${suffix}`).suffix !== legal.suffix && normalized.includes(` ${legal.core} ${suffix} `))
      throw new Error("registry website operator relationship has conflicting legal forms");
  const relative = relation.quote.indexOf(proof.subject);
  if (relative < 0 || relation.quote.lastIndexOf(proof.subject) !== relative)
    throw new Error("registry website operator relationship DBA is ambiguous");
  return { start: start + relative, end: start + relative + proof.subject.length, definitionEnd: start + relation.quote.length };
}
type DbaNeutralStructure = { subjects: Set<number>; previous: Set<number>; customer: Set<number> };
/** Offset-only interpretation of four closed neutral structures. No evidence
 * is deleted or rehashed, and caller text cannot authorize an exception. */
function dbaNeutralStructure(html: string, visibleText: string, subject: string, sourceUrl: string,
  normalization?: RegistryWebsiteNormalization): DbaNeutralStructure {
  const result: DbaNeutralStructure = { subjects: new Set(), previous: new Set(), customer: new Set() };
  // Other normalization modes retain their existing attribution behavior.
  if (normalization !== undefined) return result;
  const source = html.replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  if (registryWebsiteText(source) !== visibleText) return result;
  const escaped = subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const offset = (rawAt: number, raw: string): number | null => {
    const prefix = registryWebsiteText(source.slice(0, rawAt)), text = registryWebsiteText(raw);
    const at = prefix.length + (prefix ? 1 : 0);
    return visibleText.slice(0, prefix.length) === prefix && visibleText.slice(at, at + text.length) === text ? at : null;
  };
  const titles = [...source.matchAll(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi)];
  const heads = [...source.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)];
  if (heads.length === 1 && titles.length === 1) {
    const title = titles[0], head = heads[0];
    // A closed neutral service descriptor, never an arbitrary name after '|'.
    const grammar = new RegExp("^<title>\\s*Contact " + escaped + " \\| Trucking (?:&amp;|&) Logistics Company\\s*</title>$", "i");
    if (title.index! >= head.index! && title.index! + title[0].length <= head.index! + head[0].length && grammar.test(title[0])) {
      const at = offset(title.index!, title[0]);
      if (at !== null) result.subjects.add(at + "Contact ".length);
    }
  }
  const footers = [...source.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer\s*>/gi)];
  if (footers.length === 1 && !/<footer\b/i.test(footers[0][1])) {
    const footer = footers[0];
    // The DBA ends in its own complete copyright paragraph. Privacy Policy is
    // a separate link, not a suffix allowed in an arbitrary prose occurrence.
    const grammar = new RegExp("<p>\\s*© ([12]\\d{3}) " + escaped + "\\s*</p>\\s*(?:<div(?: class=[\"'][a-z0-9 _-]*[\"'])?>\\s*)?<a href=([\"'])([^\"'<>]+)\\2>\\s*Privacy Policy\\s*</a>", "gi");
    for (const match of footer[0].matchAll(grammar)) {
      let link: URL;
      try { link = new URL(match[3], sourceUrl); } catch { continue; }
      if (link.protocol !== "https:" || link.username || link.password || link.port || link.search || link.hash || link.hostname.replace(/^www\./, "") !== new URL(sourceUrl).hostname.replace(/^www\./, "")) continue;
      const at = offset(footer.index! + match.index!, match[0]);
      if (at !== null) result.subjects.add(at + `© ${match[1]} `.length);
    }
  }
  // Only the word 'Previous' in a complete, numeric weekly-comparison
  // paragraph is neutral. Extra prose, labels, tags or invalid dates fail closed.
  const weekly = /<p>\s*Previous week: (\d{1,3}(?:\.\d{1,2})?)%\s*<br\s*\/?>\s*Current week: (\d{1,3}(?:\.\d{1,2})?)%\s*<br\s*\/?>\s*\*Updated: (\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\s*<\/p>/gi;
  for (const match of source.matchAll(weekly)) {
    const month = Number(match[3]), day = Number(match[4]), year = Number(match[5]) + (match[5].length === 2 ? 2000 : 0);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number(match[1]) > 100 || Number(match[2]) > 100 || year < 2000 || year > 2999
      || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    const at = offset(match.index!, match[0]);
    if (at !== null) result.previous.add(at);
  }
  // Customer Login is a complete navigation control, not a customer subject.
  for (const nav of source.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav\s*>/gi)) {
    if (/<nav\b/i.test(nav[1])) continue;
    for (const link of nav[0].matchAll(/<a href=(["'])([^"'<>]+)\1>\s*Customer Login\s*<\/a>/gi)) {
      try { if (validatePublicHttpUrl(link[2]).protocol !== "https:") continue; } catch { continue; }
      const at = offset(nav.index! + link.index!, link[0]);
      if (at !== null) result.customer.add(at);
    }
  }
  return result;
}
function dbaAmbiguousAttribution(value: string, start: number, neutral?: DbaNeutralStructure): boolean {
  return [...value.matchAll(/\b(customer|client|partner|affiliate|subsidiar(?:y|ies)|parent company|third[ -]party|on behalf of|formerly|previously|former|previous)\b/gi)]
    .some(match => start < 0 || (match[0].toLowerCase() === "previous" ? !neutral?.previous.has(start + match.index!)
      : match[0].toLowerCase() === "customer" ? !neutral?.customer.has(start + match.index!) : true));
}

function dbaAttribution(proof: RegistryWebsiteCorroboration, visibleText: string, relationshipDba?: SubjectSpan, neutral?: DbaNeutralStructure) {
  // Both readers still assess the whole source. These are conservative ambiguity
  // guards, not a free-prose relationship parser or authority to clip a DBA.
  const quoteStart = visibleText.indexOf(proof.quote);
  const quoteOffset = quoteStart === visibleText.lastIndexOf(proof.quote) ? quoteStart : -1;
  if (dbaAmbiguousAttribution(proof.quote, quoteOffset, neutral))
    throw new Error("registry website DBA attribution is ambiguous");
  exactSubjectPositions(proof.quote, proof.subject);
  exactSubjectPositions(visibleText, proof.subject, false, true, relationshipDba);
  const escaped = proof.subject.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...visibleText.matchAll(new RegExp(escaped, "giu"))];
  for (const match of matches) {
    const at = match.index!, end = at + match[0].length;
    const before = visibleText.slice(Math.max(0, at - 120), at), after = visibleText.slice(end, end + 120);
    // Punctuation does not separate an added legal form or operator statement
    // from this subject. This comparison leaves source text/hash/offsets intact.
    const following = after.replace(/^[^\p{L}\p{N}]+/u, "");
    const definedDba = relationshipDba?.start === at && relationshipDba.end === end;
    // For the one parsed definition, scope attribution to that complete statement;
    // unrelated terms such as "if you do not agree" are not an operator negation.
    const attributionFollowing = definedDba ? visibleText.slice(end, relationshipDba.definitionEnd) : following;
    if (/[\p{L}\p{N}_'’&-]/u.test(visibleText[at - 1] ?? "") || /[\p{L}\p{N}_'’&-]/u.test(visibleText[end] ?? "")
      || !definedDba && !neutral?.subjects.has(at) && /^[\p{L}]/u.test(following) && !/^(?:Menu|Home|Contact|Headquarters)\b|^Skip to content\b|^ALL RIGHTS RESERVED\b/u.test(following)
      || dbaAmbiguousAttribution(before, Math.max(0, at - 120), neutral)
      || /\b(?:not|never|unrelated|belongs to|operated by|owned by)\b/i.test(attributionFollowing))
      throw new Error("registry website DBA subject is partial, conflicting or unrelated");
  }
}

function sourceTime(value: unknown): value is string {
  return typeof value === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}
function twoPageOperatorSubject(row: RegistryFinding, proof: RegistryWebsiteCorroboration, companyName: string, aliases: string[]) {
  const op = proof.operatorPage!, p = row.profile.identity;
  if (words(op.legalOperator) !== words(p.legalName) || !legalParts(p.legalName).suffix
    || words(proof.subject) !== words(companyName) || !proof.quote.includes(proof.subject)
    || !aliases.every(name => words(name) === words(companyName) || words(name) === words(p.legalName))
    || p.countryCode !== "US" || proof.address?.countryCode !== "US"
    || row.profile.dataset === "cms_nppes" && !row.profile.facts.some(f => f.field === "organization_type" && String(f.value) === "2"))
    throw new Error("two-page operator must bind exact whole legal name and canonical brand");
}
/** A closed present-tense operator definition, not a fuzzy relationship search.
 * The trailing collective definition can include unnamed employees/affiliates;
 * only the one exact legal entity before d/b/a supplies the operator role. */
function explicitOperatorDefinition(proof: RegistryWebsiteCorroboration, visibleText: string) {
  const op = proof.operatorPage!, start = visibleText.indexOf(op.quote), subject = proof.subject;
  const simple = `This website is operated by ${op.legalOperator} doing business as ${subject}.`;
  const prefix = `"${subject}," "we," "our," or "us," means ${op.legalOperator} d/b/a ${subject}, a `;
  const collective = ", our employees, officers, directors, parent, affiliates and subsidiaries.";
  const form = legalParts(op.legalOperator).suffix;
  const expectedForm = form === "llc" ? "limited liability company" : ["inc", "corp"].includes(form ?? "") ? "corporation" : null;
  const tail = op.quote.startsWith(prefix) && op.quote.endsWith(collective) ? op.quote.slice(prefix.length, -collective.length) : "";
  const definition = expectedForm && [...stateNames.values()].some(state => tail.toLowerCase() === `${state} ${expectedForm}`.toLowerCase());
  if (start < 0 || visibleText.lastIndexOf(op.quote) !== start || op.quote !== simple && !definition)
    throw new Error("two-page legal operator requires one explicit complete present-tense DBA definition");
  const before = visibleText.slice(Math.max(0,start-180),start), after = visibleText.slice(start+op.quote.length,start+op.quote.length+180);
  if (/[\p{L}\p{N}_'’&-]/u.test(visibleText[start-1] ?? "")
    || /\b(not|never|unrelated|customer|client|partner|affiliate|subsidiary|parent|former|previous|example|sample|fictional|hypothetical)\b/i.test(before)
    || /\b(?:this|that|above|preceding|definition|operator|relationship)\b[^.!?]{0,70}\b(?:not|never|no longer|former|outdated|obsolete|invalid|false|historical)\b/i.test(after))
    throw new Error("two-page operator definition context is ambiguous or contradictory");
  const other = visibleText.slice(0,start)+visibleText.slice(start+op.quote.length);
  if (/\b(?:d\s*\/\s*b\s*\/\s*a|doing business as|operated by|owned by|managed by|controlled by)\b/i.test(other))
    throw new Error("two-page website contains another operator definition");
  const legalAt = start + op.quote.indexOf(op.legalOperator);
  exactSubjectPositions(visibleText,op.legalOperator,false,false,{start:legalAt,end:legalAt+op.legalOperator.length,definitionEnd:start+op.quote.length});
  const legal = legalParts(op.legalOperator), normalized = ` ${words(visibleText)} `;
  for (const suffix of ["incorporated","inc","corporation","corp","limited","ltd","llc","llp","pllc","lp","pc"])
    if (legalParts(`${legal.core} ${suffix}`).suffix !== legal.suffix && normalized.includes(` ${legal.core} ${suffix} `))
      throw new Error("two-page operator has conflicting legal forms");
}
function contactOperatorAttribution(proof: RegistryWebsiteCorroboration, visibleText: string) {
  if (!/\b(?:office|headquarters|contact)\b/i.test(proof.quote)
    || /\b(customer|client|partner|affiliate|subsidiary|parent company|registered agent|former|previous|on behalf of)\b/i.test(proof.quote))
    throw new Error("two-page contact address has an ambiguous role");
  exactSubjectPositions(visibleText,proof.subject);
  const escaped = proof.subject.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  if (new RegExp(escaped+"[\\s.,:;()\\[\\]—-]+(?:LLC|LLP|PLLC|LP|PC|Inc\\.?|Incorporated|Corp\\.?|Corporation|Ltd\\.?|Limited)\\b","i").test(visibleText)
    || /\b(?:d\s*\/\s*b\s*\/\s*a|doing business as|operated by|owned by|managed by|controlled by)\b/i.test(visibleText))
    throw new Error("two-page contact page has a conflicting operator or legal brand");
}

function ownUrl(value: string, domain: string): string {
  const url = validatePublicHttpUrl(value);
  // Exact stored host (with optional www), not a caller-selected subsidiary host.
  const base = validatePublicHttpUrl(domain.includes("://") ? domain : `https://${domain}`);
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.hostname.replace(/^www\./, "") !== base.hostname.replace(/^www\./, "")) throw new Error("registry website must use the canonical own-domain");
  return url.toString();
}

function publicRootUrl(value: string): string {
  const url = validatePublicHttpUrl(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash
    || url.toString() !== value) throw new Error("registry website redirect requires an exact public HTTPS root");
  return url.toString();
}

/** Request-local cache only. Three bounded public fetches fit the route's 60s
 * envelope; a changed page fails closed and needs a new independent review. */
export function registryWebsiteVerifier() {
  const pages = new Map<string, Promise<PublicHttpTextResponse>>();
  async function readPage(url: string): Promise<PublicHttpTextResponse> {
    if (!pages.has(url)) {
      if (pages.size >= 3) throw new Error("registry website request exceeds three source pages");
      pages.set(url, fetchPublicHttpText(url, { timeoutMs: 8000, maxBytes: MAX_WEBSITE_SOURCE_BYTES, maxRedirects: 2, accept: "text/html,application/xhtml+xml" }));
    }
    let page: PublicHttpTextResponse;
    try { page = await pages.get(url)!; } catch (error) { throw new RegistryWebsiteAvailabilityError(url, { error }); }
    if (page.status !== 200 || !/(?:text\/html|application\/xhtml\+xml)/i.test(page.contentType ?? "")) throw new RegistryWebsiteAvailabilityError(url, { page });
    return page;
  }
  return async (row: RegistryFinding, proof: RegistryWebsiteCorroboration, company: { name: string; id?: string; netsuite_internal_id?: string | null; domain?: string | null; website_raw?: string | null },
    context: CompanyIdentityContext, now = new Date()): Promise<NonNullable<RegistryProfile["verification"]>> => {
    const identifierMode = proof.mode === "registry_identifier", dbaMode = proof.mode === "registry_dba_address", operatorMode = proof.mode === "site_operator_address";
    // This new mode always revalidates its fresh, separately bound attestations.
    if (identifierMode || dbaMode || operatorMode || proof.crmDomainReference !== undefined || proof.canonicalRedirect !== undefined || proof.normalization === "testimonials_widget_unordered_v1") proof = parseRegistryWebsiteCorroboration(proof, row, now);
    const domain = company.domain || company.website_raw;
    if (!domain) throw new Error("registry website canonical domain is missing");
    const crm = proof.crmDomainReference;
    if (crm && (!context.crmDomainReference || stableRegistryJson(context.crmDomainReference) !== stableRegistryJson(crm)
      || company.id !== row.companyId || company.netsuite_internal_id !== row.internalId
      || crm.companyName !== company.name || crm.companyId !== row.companyId || crm.internalId !== row.internalId))
      throw new Error("registry website CRM reference differs from exact server-derived account header");
    const sourceDomain = crm?.domain ?? domain;
    const redirect = proof.canonicalRedirect;
    // Only the stored canonical host can delegate. No caller-selected path or query.
    if (redirect) ownUrl(redirect.requestedUrl, domain);
    const url = redirect && proof.sourceUrl === redirect.requestedUrl ? redirect.requestedUrl : ownUrl(proof.sourceUrl, redirect?.finalUrl ?? sourceDomain);
    if (redirect && (new URL(url).search || new URL(url).hash)) throw new Error("registry website redirect source cannot have a query or fragment");
    if (crm && (new URL(url).search || new URL(url).hash)) throw new Error("CRM-referenced website requires an exact source path");
    const p = row.profile.identity, a = proof.address;
    const cslbMode = identifierMode && proof.identifier?.kind === "cslb_license";
    if (!a && !cslbMode) throw new Error("registry website complete address is required");
    const possessiveAddress = !identifierMode && !dbaMode && a?.countryCode === "US" && (p.countryCode ?? "US") === "US"
      && typeof p.city === "string" && p.city.length > 0 && words(a.city) === words(p.city) && words(a.state) === words(p.state)
      && a.postalCode.slice(0, 5) === p.postalCode.slice(0, 5) && sameRegistryStreet(a, p)
      && [company.name, ...context.aliases].some(name => sameRegistryLegalName(name, p.legalName));
    // CRM-referenced ordinary proofs retain whole legal-name agreement only.
    const sameSubject = (left: string, right: string) => crm && proof.mode === undefined
      ? sameRegistryLegalName(left, right) : sameRegistryLegalName(left, right)
      || (possessiveAddress && samePossessiveWebsiteSubject(left, right))
      || (!identifierMode && a?.countryCode === "US" && p.countryCode === "US" && sameLimitedCompanySubject(left, right));
    if (operatorMode) twoPageOperatorSubject(row, proof, company.name, context.aliases);
    const originalDba = dbaMode ? dbaSubject(row, proof, company.name, context.aliases) : null;
    if (proof.operatorRelationship) operatorRelationshipSpan(proof, proof.operatorRelationship.quote, redirect?.finalUrl ?? sourceDomain);
    if (!dbaMode && !operatorMode && (![company.name, ...context.aliases].some(name => sameSubject(name, proof.subject))
      || !sameSubject(proof.subject, p.legalName) || !proof.quote.includes(proof.subject))) throw new Error("registry website subject does not match canonical legal entity");
    // Relationship/location ambiguities stay held even on the account's own site.
    if (/\b(subsidiar(?:y|ies)|parent company|registered agent|customer(?:'s|’s)? (?:address|office|headquarters)|client(?:'s|’s)? (?:address|office)|former (?:address|office)|previous (?:address|office)|old (?:address|office))\b/i.test(proof.quote))
      throw new Error("registry website address attribution is ambiguous");
    const stateSpellings = a ? [a.state, ...(a.countryCode === "US" && stateNames.has(a.state) ? [stateNames.get(a.state)!] : []),
      ...(a.countryCode === "CA" && a.state === "AB" ? ["Alberta"] : [])] : [];
    // Canada's country word may occur inside this one complete address block.
    // Do not collect a province/country from elsewhere or modify street/unit data.
    const completeLocality = a && stateSpellings.some(state => contains(proof.quote, `${a.city} ${state} ${a.postalCode}`)
      || (a.countryCode === "CA" && a.state === "AB" && contains(proof.quote, `${a.city} ${state} Canada ${a.postalCode}`)));
    if (a && (![a.addressLine1, a.addressLine2].filter((v): v is string => Boolean(v)).every(value => contains(proof.quote, value))
      || !completeLocality
      || (!identifierMode && (words(a.state) !== words(p.state) || a.countryCode !== (p.countryCode ?? "US")
      || (a.countryCode === "CA" ? words(a.postalCode).replace(/ /g, "") !== words(p.postalCode).replace(/ /g, "") : a.postalCode.slice(0, 5) !== p.postalCode.slice(0, 5))))))
      throw new Error("registry website complete address is not corroborated");
    if (identifierMode && proof.identifier?.kind === "cra_charity_registration" && (!a || a.countryCode !== "CA"
      || !/^(AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT)$/.test(a.state) || !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(a.postalCode)))
      throw new Error("registry CRA identifier requires an explicit complete Canadian website address");
    if (identifierMode && proof.identifier?.kind !== "cra_charity_registration" && a && (a.countryCode !== "US" || !stateNames.has(a.state) || !/^\d{5}(?:-\d{4})?$/.test(a.postalCode)))
      throw new Error("registry identifier requires an explicit complete US website address");
    if (crm && proof.mode === undefined && (!a || !p.city || words(a.city) !== words(p.city)))
      throw new Error("registry website CRM complete source city is required");
    if ((dbaMode || operatorMode) && (!a || !p.countryCode || !p.city || words(a.city) !== words(p.city)))
      throw new Error("registry website DBA complete source city and country are required");
    // Structural heading evidence is checked after the unchanged whole-page read.
    if (identifierMode) identifierAttribution(row, proof, proof.quote, true);
    // DBA attribution needs the actual hash-checked HTML to identify neutral structure.
    const exactStreet = a ? sameRegistryStreet(a, p) : false;
    // FMCSA's verified USDOT binds this narrow highway-format discrepancy. No
    // unit, house number, road number, country or postal evidence is discarded.
    const dot = row.profile.dataset === "fmcsa" && /^\d+$/.test(row.profile.recordId)
      && String(row.profile.provenance.sourceRow.usdot_number) === row.profile.recordId
      && new RegExp(`\\b(?:US\\s*)?DOT\\s*#?\\s*${row.profile.recordId}\\b`, "i").test(proof.quote);
    const highwayEquivalent = dot && Boolean(a) && registryStreet(a!).replace(/\bus hwy\b/g, "hwy") === registryStreet(p).replace(/\bus hwy\b/g, "hwy");
    if (!identifierMode && !exactStreet && (crm || dbaMode || operatorMode || !highwayEquivalent)) throw new Error("registry website street or unit differs from source record");
    let canonicalRedirectVerification: Record<string, unknown> | undefined;
    if (redirect) {
      const root = await readPage(redirect.requestedUrl);
      if (root.finalUrl !== redirect.finalUrl || sha(registryWebsiteText(root.body)) !== redirect.normalizedVisibleTextSha256)
        throw new Error("registry website canonical redirect changed");
      canonicalRedirectVerification = { ...redirect, fetchedAt: now.toISOString(), htmlSha256: sha(root.body) };
    }
    const page = await readPage(url);
    ownUrl(page.finalUrl, redirect?.finalUrl ?? sourceDomain);
    if (crm && page.finalUrl !== url) throw new Error("CRM-referenced website redirected from its reviewed path");
    if (operatorMode && page.finalUrl !== url) throw new Error("two-page contact source redirected from its reviewed path");
    const visibleText = registryWebsiteText(page.body, proof.normalization), start = visibleText.indexOf(proof.quote);
    if (sha(visibleText) !== proof.normalizedVisibleTextSha256 || start < 0)
      throw new RegistryWebsiteMismatchError(page, proof, visibleText, new Date().toISOString());
    if (proof.normalization === "testimonials_widget_unordered_v1" && !registryWebsiteQuoteOutsideWidget(page.body, proof.quote))
      throw new Error("registry website identity quote must be wholly outside the unordered widget");
    // A longer address proof is the entire page, never joined or clipped passages.
    if (redirect && !proof.mode && proof.quote.length > 1800 && proof.quote !== visibleText)
      throw new Error("registry website extended redirect quote must be the full visible page");
    if (identifierMode) identifierAttribution(row, proof, visibleText, separateContactHeadingSubjects(page.body, visibleText, proof.subject, proof.normalization));
    if (dbaMode) {
      dbaAttribution(proof, visibleText, operatorRelationshipSpan(proof, visibleText, redirect?.finalUrl ?? sourceDomain),
        dbaNeutralStructure(page.body, visibleText, proof.subject, page.finalUrl, proof.normalization));
      if (labelledIdentifiers(visibleText, "usdot").some(id => id.value !== row.profile.recordId))
        throw new Error("registry website DBA has a conflicting labelled USDOT");
    }
    let operatorPageVerification: Record<string, unknown> | undefined;
    if (operatorMode) {
      const op = proof.operatorPage!, operatorUrl = ownUrl(op.sourceUrl, domain);
      if (operatorUrl === url || new URL(operatorUrl).hash || new URL(url).hash || new URL(operatorUrl).search || new URL(url).search)
        throw new Error("two-page operator and contact sources must be distinct exact paths");
      contactOperatorAttribution(proof, visibleText);
      const operator = await readPage(operatorUrl);ownUrl(operator.finalUrl, domain);
      if (operator.finalUrl === page.finalUrl) throw new Error("two-page sources resolve to the same page");
      if (operator.finalUrl !== operatorUrl) throw new Error("two-page operator source redirected from its reviewed path");
      const operatorText = registryWebsiteText(operator.body);
      if (sha(operatorText) !== op.normalizedVisibleTextSha256 || !operatorText.includes(op.quote))
        throw new RegistryWebsiteMismatchError(operator, { ...proof, sourceUrl:op.sourceUrl, normalizedVisibleTextSha256:op.normalizedVisibleTextSha256, quote:op.quote, quoteSha256:op.quoteSha256 }, operatorText, new Date().toISOString());
      explicitOperatorDefinition(proof, operatorText);
      const quoteStart = operatorText.indexOf(op.quote);
      operatorPageVerification = { finalUrl:operator.finalUrl, fetchedAt:now.toISOString(), htmlSha256:sha(operator.body), quoteStart, quoteEnd:quoteStart+op.quote.length };
    }
    const sourceId = `website:sha256:${proof.normalizedVisibleTextSha256}`;
    return { method: "official_website_corroboration", verifiedAt: now.toISOString(), sourceIds: [...new Set([sourceId, ...(crm ? [`netsuite_record:${crm.recordId}:header:sha256:${crm.headerSha256}`] : []), ...(redirect ? [`website:sha256:${redirect.normalizedVisibleTextSha256}`] : []), ...(operatorMode ? [`website:sha256:${proof.operatorPage!.normalizedVisibleTextSha256}`] : [])])], website: {
      ...proof, ...(crm ? { crmDomainReferenceVerification: { ...crm, sourceRole: "latest_retained_labelled_provisioning_email_domain_reference", canonicalDomain: domain, canonicalDomainChanged: false } } : {}), ...(canonicalRedirectVerification ? { canonicalRedirectVerification } : {}), finalUrl: page.finalUrl, fetchedAt: now.toISOString(), htmlSha256: sha(page.body), quoteStart: start, quoteEnd: start + proof.quote.length,
      binding: operatorMode ? "exact_own_site_legal_operator_dba_two_page_full_address" : dbaMode ? proof.operatorRelationship ? "exact_original_registry_dba_defined_canonical_full_address" : "exact_original_registry_dba_full_address" : identifierMode ? "exact_" + proof.identifier!.kind + "_legal_subject" : exactStreet ? "exact_legal_name_address" : "exact_usdot_highway_format", registryAddress: p,
      ...(identifierMode ? { websiteAddress: a ?? null, addressRelationship: a ? "separate_observations_not_address_equivalence" : "website_address_unknown_registry_address_retained" } : {}),
      ...(dbaMode ? { originalDba, originalLegalOperator: p.legalName, websiteAddress: a } : {}),
      ...(operatorMode ? { operatorPageVerification, originalLegalOperator:p.legalName, websiteDba:proof.subject, websiteAddress:a,
        sourceRoles:{contact:"company_contact_address",operator:"explicit_website_legal_operator_dba"},
        addressRelationship:"website_contact_matches_original_registry_address_canonical_prior_addresses_retained" } : {}),
      priorAddresses: context.addresses, structuredIdentity: extractCompanyIdentity(page.body, page.finalUrl, candidate => sameCompanySite(candidate, page.finalUrl)) ?? null,
    } };
  };
}
