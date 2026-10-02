import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { registryContentHash, sameRegistryLegalName, sameRegistryStreet, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";
import { registrySamCanonicalHash } from "@/lib/agent/registrySam";
import officialSummaries from "./registryOfficialSummaries.json";
import { verifyRegistryOfficialApi, type RegistryOfficialApiCorroboration } from "./registryOfficialApi";

// Fixed reviewed facts, not caller-authored transcription or arbitrary PDF URLs.
// Binary hashes bind the visually read documents; they do not OCR/authenticate
// an arbitrary submission. Adding a bundle requires source and code review.
const BUNDLE = {
  "id": "co_sos_19961162961_reviewed_20261001",
  "companyId": "26b28bb0-94ef-464c-8672-45a4d8b2aa3c",
  "internalId": "67075248",
  "canonicalDomain": "alliance-leasing.com",
  "entityId": "19961162961",
  "legalName": "SPITZ FINANCIAL SERVICES, INC.",
  "tradeNames": [
    {
      "name": "ALLIANCE LEASING CORP.",
      "documentId": "19971008601",
      "effectiveDate": "1997-01-21"
    },
    {
      "name": "Alliance Commercial Leasing and Finance",
      "documentId": "20101079937",
      "effectiveDate": "2010-02-06"
    },
    {
      "name": "Alliance Fleet Solutions",
      "documentId": "20191557427",
      "effectiveDate": "2019-07-10"
    }
  ],
  "manifestSha256": "ec8d7ea558e30c1cf1813c0646c6084e54392923f71f5dfd73278d598a8759a9",
  "sourceReader": {
    "taskId": "/root/source_outcome_reporting",
    "reviewedAt": "2026-10-01T02:01:31.224Z",
    "receiptSha256": "1c1e62d031ea15be1125b3251bbff2a4853b67cb62aeca177ba685670aba78b6"
  },
  "sourceReviewer": {
    "taskId": "/root/sweep_reporting_fix",
    "reviewedAt": "2026-10-01T02:04:42.066Z",
    "receiptSha256": "9f011428a1e8458300fd0ecfcfc08daff7d92503509c777827af02b3cc15ff9c"
  },
  "sources": [
    {
      "id": "co-1997-tradename-filing",
      "url": "https://www.coloradosos.gov/biz/ViewImage.do?masterFileId=19971008601&fileId=19971008601",
      "observedAt": "2026-10-01T01:58:57.445Z",
      "bodySha256": "ec45d2ebed48a5e5c43df7fc013ed7dac422a382270b3bcd848eee5e215cae53",
      "receiptSha256": "730023bc131160f0c25bb793a72f5e9a74465e601f9765b62621d290370c7983",
      "visuallyReviewedPages": [
        {
          "page": 1,
          "renderSha256": "c58286d1c906b35df3739b0dd7a3ed6c4ebdbf7ad8e51232aa8b418f2817c4ea"
        }
      ]
    },
    {
      "id": "co-2006-periodic-report",
      "url": "https://www.coloradosos.gov/biz/ViewImage.do?masterFileId=19961162961&fileId=20061003057",
      "observedAt": "2026-10-01T01:57:06.298Z",
      "bodySha256": "cfbbf962d0704de489ac6dc2047b11c08f83314e1c1229cfa48579224e4b67fe",
      "receiptSha256": "6e5cdeaebd70c3276913d821005d0b56774ac6ea4d9efbf6a85b9c33c9976829",
      "visuallyReviewedPages": [
        {
          "page": 1,
          "renderSha256": "b86d3d44c57abe1209b53a154b1a2e04abb6643f7ba642a8548d774c0f03c038"
        },
        {
          "page": 2,
          "renderSha256": "e5ae878b0d0275cd2a987d6f7ba9d8d212f7bc825c9fd24749bf5f52a5a90c69"
        }
      ]
    },
    {
      "id": "co-entity-detail",
      "url": "https://www.coloradosos.gov/biz/BusinessEntityDetail.do?quitButtonDestination=BusinessEntityResults&nameTyp=ENT&masterFileId=19961162961&entityId2=19961162961&fileId=19961162961&srchTyp=ENTITY",
      "observedAt": "2026-10-01T01:54:04.636Z",
      "bodySha256": "33937f6e68cace3c669d5b05b78e3e0e85b5d067c100ed59dd2dc3362ff11ef5",
      "receiptSha256": "0db4af4fb3d0de08692a8bd42776a1e731beeb2b62ea9125e36af1caf9aac808",
      "textSha256": "db415e2cc9917eab7ac5aff019ee30c5318ff1a6c491ec632764836c1f85ed94"
    },
    {
      "id": "co-entity-tradenames-session",
      "url": "https://www.coloradosos.gov/biz/TradenameOwnerResults.do?quitButtonDestination=BusinessEntityDetail&masterFileId=19961162961&nameTyp=ENT",
      "observedAt": "2026-10-01T01:56:08.450Z",
      "bodySha256": "3be9c0993414793e327b552e96dd684f32d0255b10bfc57b664264203c67d34d",
      "receiptSha256": "85a26b9e2c018c251a22381c546a562d6097525776a569b74d507a5179566d0a",
      "textSha256": "8a1413f5f04eed35064c03b53a382fbeafcd8f43bf750a5d78743b554032fe58"
    },
    {
      "id": "co-exact-legal-entity",
      "url": "https://data.colorado.gov/resource/4ykn-tg5h.json?%24where=upper%28entityname%29+in%28%27ALLIANCE+LEASING+CORP.%27%2C%27ALLIANCE+LEASING+CORP%27%2C%27ALLIANCE+LEASING+CORPORATION%27%2C%27SPITZ+FINANCIAL+SERVICES+INC%27%2C%27SPITZ+FINANCIAL+SERVICES%2C+INC.%27%2C%27SPITZ+FINANCIAL+SERVICES%2C+INC%27%29&%24limit=20",
      "observedAt": "2026-10-01T01:52:51.186Z",
      "bodySha256": "0b3e66726f74f7eb444fba29a7814c330d194a6d79c5a3f3b8b5f67064c94cb5",
      "receiptSha256": "da95db67bb73f480f4c2bad666e28cb47d5b168cc879940887a9c2a22d6b6fb6",
      "textSha256": "0b3e66726f74f7eb444fba29a7814c330d194a6d79c5a3f3b8b5f67064c94cb5"
    }
  ],
  "anchor": {
    "role": "principal_office",
    "sourceId": "co-1997-tradename-filing",
    "documentId": "19971008601",
    "sourceAsOf": "1997-01-21",
    "address": {
      "addressLine1": "2075 S. University Blvd. #289",
      "city": "Denver",
      "state": "CO",
      "postalCode": "80210",
      "countryCode": "US"
    }
  },
  "addresses": {
    "university_mailing_2006": {
      "role": "principal_mailing",
      "sourceId": "co-2006-periodic-report",
      "documentId": "20061003057",
      "sourceAsOf": "2006-01-03",
      "address": {
        "addressLine1": "2075 S. University, #289",
        "city": "Denver",
        "state": "CO",
        "postalCode": "80210",
        "countryCode": "US"
      }
    },
    "girard_principal_observed_20261001": {
      "role": "principal_street",
      "sourceId": "co-exact-legal-entity",
      "documentId": "19961162961",
      "sourceAsOf": "2026-10-01",
      "address": {
        "addressLine1": "10200 E Girard Ave Ste B223",
        "city": "Denver",
        "state": "CO",
        "postalCode": "80231",
        "countryCode": "US"
      }
    }
  }
} as const;

type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
export type RegistryOfficialHistoryCorroboration = {
  schema: "colorado_sos_history_v1"; bundleId: string; bundleSha256: string;
  canonicalIdentitySha256: string; addressEntryKey: keyof typeof BUNDLE.addresses;
  reader: Attestation; reviewer: Attestation;
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const BUNDLE_SHA = sha(stableRegistryJson(BUNDLE));
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const iso = (v: unknown): v is string => typeof v === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// Return fresh metadata: consumers cannot mutate the verifier's private bundle.
export function registryOfficialHistoryBundle() {
  return { id: BUNDLE.id, sha256: BUNDLE_SHA, addressEntryKeys: Object.keys(BUNDLE.addresses) as (keyof typeof BUNDLE.addresses)[] };
}
export const registryOfficialHistoryCanonicalHash = registrySamCanonicalHash;
export function registryOfficialHistoryEvidenceHash(row: RegistryFinding, proof: Omit<RegistryOfficialHistoryCorroboration, "reader" | "reviewer"> | Omit<RegistryOfficialSummaryCorroboration, "reader" | "reviewer"> | Omit<RegistryOfficialApiCorroboration, "reader" | "reviewer">): string {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId,
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}
function parseProof(raw: unknown, row: RegistryFinding, now: Date): RegistryOfficialHistoryCorroboration {
  const keys = ["schema", "bundleId", "bundleSha256", "canonicalIdentitySha256", "addressEntryKey", "reader", "reviewer"];
  if (!object(raw) || Object.keys(raw).some(k => !keys.includes(k)) || keys.some(k => !(k in raw))
    || raw.schema !== "colorado_sos_history_v1" || raw.bundleId !== BUNDLE.id || raw.bundleSha256 !== BUNDLE_SHA
    || !hash(raw.canonicalIdentitySha256) || typeof raw.addressEntryKey !== "string"
    || !Object.hasOwn(BUNDLE.addresses, raw.addressEntryKey)) throw new Error("invalid reviewed official history bundle");
  const { reader, reviewer, ...evidence } = raw;
  const evidenceSha256 = registryOfficialHistoryEvidenceHash(row, evidence as Omit<RegistryOfficialHistoryCorroboration, "reader" | "reviewer">);
  const earliestReview = Math.max(Date.parse(row.profile.observedAt), Date.parse(BUNDLE.sourceReader.reviewedAt),
    Date.parse(BUNDLE.sourceReviewer.reviewedAt), ...BUNDLE.sources.map(s => Date.parse(s.observedAt)));
  // Actual readers attest the original target, complete source bundle, current
  // identity, dated role and final analysis/detail. IDs are authenticated-agent
  // attestations, not cryptographic proof that two different humans read them.
  for (const a of [reader, reviewer]) {
    if (!object(a) || Object.keys(a).some(k => !["taskId", "reviewedAt", "evidenceSha256"].includes(k))
      || typeof a.taskId !== "string" || a.taskId.length > 160 || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(a.taskId)
      || !iso(a.reviewedAt) || Date.parse(a.reviewedAt) < earliestReview || Date.parse(a.reviewedAt) > now.getTime() + 60000
      || now.getTime() - Date.parse(a.reviewedAt) > 7 * 86400000 || a.evidenceSha256 !== evidenceSha256)
      throw new Error("official history review does not bind exact publication evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("official history requires independent review");
  return raw as RegistryOfficialHistoryCorroboration;
}
type Address = { addressLine1: string; addressLine2?: string; city?: string; state?: string; postalCode?: string; countryCode?: string };
function fullAddress(a: Address, b: Address): boolean {
  const az = a.postalCode?.replace(/-/g, ""), bz = b.postalCode?.replace(/-/g, "");
  return typeof a.addressLine1 === "string" && typeof b.addressLine1 === "string"
    && a.countryCode === "US" && b.countryCode === "US" && a.state === b.state
    && Boolean(a.city && b.city && words(a.city) === words(b.city))
    && Boolean(az && bz && /^\d{5}(?:\d{4})?$/.test(az) && /^\d{5}(?:\d{4})?$/.test(bz)
      && az.slice(0, 5) === bz.slice(0, 5) && !(az.length === 9 && bz.length === 9 && az !== bz))
    && sameRegistryStreet(a, b);
}
function originalUccCountry(row: RegistryFinding): "US" {
  // The normalized UCC identity can omit country. Read it from the exact hashed
  // original debtor row, never invent it or borrow it from the history bundle.
  const lines = row.evidence.split("\n");
  let debtor: unknown, filing: unknown;
  try { debtor = JSON.parse(lines[0]); filing = JSON.parse(lines[1]); } catch { throw new Error("official history requires original UCC debtor and filing rows"); }
  const t = row.profile.identity, url = new URL(row.sourceUrl);
  if (row.profile.dataset !== "co_ucc" || lines.length !== 2 || !object(debtor) || !object(filing)
    || sha(lines[0]) !== row.profile.provenance.rowSha256 || row.profile.provenance.quote !== row.evidence
    || debtor.country !== "United States" || t.countryCode !== undefined && t.countryCode !== "US"
    || debtor.organizationname !== t.legalName || debtor.address1 !== t.addressLine1 || (debtor.address2 || "") !== (t.addressLine2 || "")
    || debtor.city !== t.city || debtor.state !== t.state || debtor.zipcode !== t.postalCode
    || row.profile.recordId !== `${debtor.fileid}:${debtor.debtorid}` || filing.fileid !== debtor.fileid
    || url.protocol !== "https:" || url.hostname !== "data.colorado.gov" || url.pathname !== "/resource/8upq-58vz.json"
    || url.searchParams.get("debtorid") !== debtor.debtorid) throw new Error("official history original UCC identity or country differs");
  return "US";
}
export function verifyRegistryOfficialHistory(row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now = new Date()): NonNullable<RegistryProfile["verification"]> {
  if (object(raw) && raw.schema === "official_api_roles_v1") return verifyRegistryOfficialApi(row, raw, company, context, now);
  if (object(raw) && raw.schema === "colorado_sos_summary_roles_v1") return verifyOfficialSummary(row, raw, company, context, now);
  const proof = parseProof(raw, row, now);
  const countryCode = originalUccCountry(row);
  let domain: string | null = null;
  try {
    const value = company.domain || company.website_raw || "", u = new URL(value.includes("://") ? value : `https://${value}`);
    if (/^https?:$/.test(u.protocol) && !u.username && !u.password && !u.port) domain = u.hostname.toLowerCase().replace(/^www\./, "");
  } catch { /* Invalid canonical domains fail closed below. */ }
  if (row.companyId !== BUNDLE.companyId || row.internalId !== BUNDLE.internalId || company.id !== row.companyId
    || company.netsuite_internal_id !== row.internalId || domain !== BUNDLE.canonicalDomain
    || proof.canonicalIdentitySha256 !== registryOfficialHistoryCanonicalHash(company, context)) throw new Error("official history canonical identity changed");
  const names: readonly string[] = [BUNDLE.legalName, ...BUNDLE.tradeNames.map(t => t.name)];
  const compatible = (name: string) => names.some(legal => sameRegistryLegalName(name, legal));
  if (!compatible(company.name) || context.aliases.some(name => !compatible(name)) || !compatible(row.profile.identity.legalName))
    throw new Error("official history legal operator or registered trade name differs");
  const anchor = context.addresses.find(a => ["netsuite_record", "company_website"].includes(a.sourceKind)
    && Boolean(a.sourceId) && iso(a.capturedAt) && fullAddress(a, BUNDLE.anchor.address));
  if (!anchor) throw new Error("official history requires the complete existing canonical anchor");
  if ([proof.reader, proof.reviewer].some(a => Date.parse(a.reviewedAt) < Date.parse(anchor.capturedAt)))
    throw new Error("official history review predates canonical anchor");
  // UCC debtor/business addresses can be historical mailing addresses. Do not
  // extend this to carrier physical addresses or infer continuous occupancy.
  const entry = BUNDLE.addresses[proof.addressEntryKey];
  if (!fullAddress({ ...row.profile.identity, countryCode }, entry.address))
    throw new Error("official history dated address or target role differs");
  const { reader, reviewer, ...evidence } = proof;
  return { method: "reviewed_official_registration_history", verifiedAt: now.toISOString(),
    sourceIds: [`co_sos:${BUNDLE.entityId}:${BUNDLE_SHA}`, anchor.sourceId],
    officialHistory: { ...evidence, reader, reviewer, evidenceSha256: registryOfficialHistoryEvidenceHash(row, evidence),
      bundle: JSON.parse(JSON.stringify(BUNDLE)), addressEntry: JSON.parse(JSON.stringify(entry)), canonicalAnchor: { ...anchor },
      scope: "Dated official legal/trade-name and address evidence only. Historical mailing is not physical occupancy; no current registration, debt or company-address mutation is asserted." } };
}

type SummaryRole = "principal_street" | "principal_mailing" | "registered_agent_street";
type SummaryEntry = {
  id: string; companyId: string; internalId: string; canonicalDomain: string; canonicalIdentitySha256: string;
  entityId: string; legalName: string;
  source: { requestedUrl: string; finalUrl: string; status: number; observedAt: string; bodySha256: string; textSha256: string; receiptSha256: string };
  sourceReader: { taskId: string; reviewedAt: string; receiptSha256: string };
  sourceReviewer: { taskId: string; reviewedAt: string; receiptSha256: string };
  target: { dataset: string; recordId: string; sourceUrl: string; rowSha256: string; evidenceSha256: string;
    identitySha256: string; sourceRowSha256: string; factsSha256: string; sourceAsOf: string | null; observedAt: string; role: "principal_street" };
  addresses: Record<SummaryRole, Address>; registeredAgentName: string;
  anchor: { mode: "single_explicit_role" | "principal_street_plus_mailing"; role?: SummaryRole; sourceId: string };
};
export type RegistryOfficialSummaryCorroboration = {
  schema: "colorado_sos_summary_roles_v1"; entryId: string; entrySha256: string;
  canonicalIdentitySha256: string; targetAddressRole: "principal_street";
  reader: Attestation; reviewer: Attestation;
};
const summaries = officialSummaries.entries as SummaryEntry[];
// Data is reviewed with the deployed code. The caller cannot provide a new
// transcription/URL or change an address role. Return copies, never live state.
export function registryOfficialSummaryEntry(id: string) {
  const matches = summaries.filter(e => e.id === id);
  if (officialSummaries.version !== 1 || summaries.length > 128 || matches.length !== 1) throw new Error("unknown reviewed official summary");
  return { entry: JSON.parse(JSON.stringify(matches[0])) as SummaryEntry, sha256: sha(stableRegistryJson(matches[0])) };
}
function officialSummaryUrl(value: string, entityId: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "www.coloradosos.gov" && !url.username && !url.password && !url.port && !url.hash
      && url.pathname === "/biz/BusinessEntityDetail.do"
      && ["masterFileId", "entityId2", "fileId"].every(k => url.searchParams.getAll(k).length === 1 && url.searchParams.get(k) === entityId);
  } catch { return false; }
}
function verifyOfficialSummary(row: RegistryFinding, raw: Record<string, unknown>, company: Company, context: CompanyIdentityContext, now: Date): NonNullable<RegistryProfile["verification"]> {
  const keys = ["schema", "entryId", "entrySha256", "canonicalIdentitySha256", "targetAddressRole", "reader", "reviewer"];
  if (Object.keys(raw).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(raw, k)) || typeof raw.entryId !== "string")
    throw new Error("invalid official summary proof");
  const { entry, sha256 } = registryOfficialSummaryEntry(raw.entryId);
  if (raw.entrySha256 !== sha256 || raw.targetAddressRole !== "principal_street" || entry.target.role !== "principal_street")
    throw new Error("official summary entry or target role differs");
  const source = entry.source, roles: SummaryRole[] = ["principal_street", "principal_mailing", "registered_agent_street"];
  if (!/^\d{11}$/.test(entry.entityId) || source.status !== 200 || !iso(source.observedAt)
    || !officialSummaryUrl(source.requestedUrl, entry.entityId) || !officialSummaryUrl(source.finalUrl, entry.entityId)
    || ![source.bodySha256, source.textSha256, source.receiptSha256].every(hash)
    || entry.sourceReader.taskId === entry.sourceReviewer.taskId
    || [entry.sourceReader, entry.sourceReviewer].some(a => !a.taskId || !iso(a.reviewedAt) || Date.parse(a.reviewedAt) < Date.parse(source.observedAt) || !hash(a.receiptSha256))
    || roles.some(role => !entry.addresses[role] || !fullAddress(entry.addresses[role], entry.addresses[role])))
    throw new Error("official summary source or typed roles invalid");
  let domain: string | null = null;
  try {
    const value = company.domain || company.website_raw || "", url = new URL(value.includes("://") ? value : `https://${value}`);
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && !url.port) domain = url.hostname.toLowerCase().replace(/^www\./, "");
  } catch { /* Fail closed below. */ }
  if (company.id !== entry.companyId || row.companyId !== entry.companyId || company.netsuite_internal_id !== entry.internalId
    || row.internalId !== entry.internalId || domain !== entry.canonicalDomain
    || raw.canonicalIdentitySha256 !== entry.canonicalIdentitySha256
    || raw.canonicalIdentitySha256 !== registryOfficialHistoryCanonicalHash(company, context)
    || !sameRegistryLegalName(company.name, entry.legalName) || context.aliases.some(n => !sameRegistryLegalName(n, entry.legalName)))
    throw new Error("official summary canonical identity or legal operator changed");
  const target = row.profile, t = target.identity, pin = entry.target;
  let original: unknown;
  try { original = JSON.parse(row.evidence); } catch { throw new Error("official summary requires original Colorado entity JSON"); }
  // Restrict this method to exact retained entity records. Full original source
  // fields and dates are pinned; a matching name or agent address cannot create
  // a new target. This never admits carrier physical-address or UCC claims.
  if (!object(original) || target.dataset !== "co_sos" || pin.dataset !== "co_sos" || target.recordId !== entry.entityId || pin.recordId !== entry.entityId
    || row.sourceUrl !== pin.sourceUrl || target.sourceAsOf !== pin.sourceAsOf || target.observedAt !== pin.observedAt
    || target.provenance.rowSha256 !== pin.rowSha256 || sha(row.evidence) !== pin.rowSha256 || sha(row.evidence) !== pin.evidenceSha256
    || target.provenance.quote !== row.evidence || sha(stableRegistryJson(t)) !== pin.identitySha256
    || sha(stableRegistryJson(target.provenance.sourceRow)) !== pin.sourceRowSha256
    || sha(stableRegistryJson(target.facts.map(({ field, value }) => ({ field, value })))) !== pin.factsSha256
    || original.entityid !== entry.entityId || original.entityname !== t.legalName || words(t.legalName) !== words(entry.legalName)
    || original.principaladdress1 !== t.addressLine1 || (original.principaladdress2 || "") !== (t.addressLine2 || "")
    || original.principalcity !== t.city || original.principalstate !== t.state || original.principalzipcode !== t.postalCode
    || original.principalcountry !== "US" || t.countryCode !== "US"
    || !fullAddress(t, entry.addresses.principal_street)) throw new Error("official summary original entity or principal address differs");
  const targetUrl = new URL(row.sourceUrl);
  if (targetUrl.protocol !== "https:" || targetUrl.hostname !== "data.colorado.gov" || targetUrl.pathname !== "/resource/4ykn-tg5h.json"
    || targetUrl.username || targetUrl.password || targetUrl.port || targetUrl.hash
    || targetUrl.searchParams.getAll("entityid").length !== 1 || targetUrl.searchParams.get("entityid") !== entry.entityId)
    throw new Error("official summary target URL differs");
  let expectedAnchor: Address;
  const anchorSpec = entry.anchor;
  if (anchorSpec.mode === "single_explicit_role" && anchorSpec.role && roles.includes(anchorSpec.role)) {
    expectedAnchor = entry.addresses[anchorSpec.role];
  } else if (anchorSpec.mode === "principal_street_plus_mailing" && anchorSpec.role === undefined) {
    const street = entry.addresses.principal_street, mail = entry.addresses.principal_mailing;
    // This is comparison to two explicitly labelled full addresses, not a
    // general split/strip heuristic. No units, street tokens or box digits drop.
    if (street.addressLine2?.trim() || mail.addressLine2?.trim() || !/^\d/.test(street.addressLine1)
      || !/^po box [0-9]+$/i.test(mail.addressLine1) || street.countryCode !== mail.countryCode || street.state !== mail.state
      || words(street.city ?? "") !== words(mail.city ?? "") || street.postalCode !== mail.postalCode)
      throw new Error("official summary composed address roles differ");
    expectedAnchor = { ...street, addressLine1: `${street.addressLine1} ${mail.addressLine1}` };
  } else throw new Error("official summary anchor role invalid");
  const anchors = context.addresses.filter(a => a.sourceId === anchorSpec.sourceId && ["netsuite_record", "company_website"].includes(a.sourceKind)
    && iso(a.capturedAt) && fullAddress(a, expectedAnchor));
  if (anchors.length !== 1) throw new Error("official summary complete canonical role anchor missing or ambiguous");
  const { reader, reviewer, ...evidence } = raw;
  const bound = registryOfficialHistoryEvidenceHash(row, evidence as Omit<RegistryOfficialSummaryCorroboration, "reader" | "reviewer">);
  const earliest = Math.max(Date.parse(target.observedAt), Date.parse(source.observedAt), Date.parse(entry.sourceReader.reviewedAt),
    Date.parse(entry.sourceReviewer.reviewedAt), Date.parse(anchors[0].capturedAt));
  for (const a of [reader, reviewer]) {
    if (!object(a) || Object.keys(a).some(k => !["taskId", "reviewedAt", "evidenceSha256"].includes(k))
      || typeof a.taskId !== "string" || a.taskId.length > 160 || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(a.taskId)
      || !iso(a.reviewedAt) || Date.parse(a.reviewedAt) < earliest || Date.parse(a.reviewedAt) > now.getTime() + 60000
      || now.getTime() - Date.parse(a.reviewedAt) > 7 * 86400000 || a.evidenceSha256 !== bound)
      throw new Error("official summary review does not bind exact publication evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("official summary requires independent review");
  return { method: "reviewed_official_registration_history", verifiedAt: now.toISOString(),
    sourceIds: [`co_sos:${entry.entityId}:${sha256}`, anchors[0].sourceId],
    officialHistory: { ...evidence, reader, reviewer, evidenceSha256: bound, entry, canonicalAnchor: { ...anchors[0] },
      targetAddress: { role: "principal_street", ...entry.addresses.principal_street }, canonicalAnchorRoles: anchorSpec,
      scope: "Observed official entity/address-role association. Mailing and registered-agent addresses are not operating-location claims. Original source dates and address roles remain distinct." } };
}
