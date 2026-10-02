import { createHash } from "node:crypto";
import type { CompanyIdentityContext } from "@/lib/companyIdentity";
import { normalizedDba, registryContentHash, sameRegistryLegalName, sameRegistryStreet, sameRegistryTerminalFloor, stableRegistryJson, type RegistryFinding, type RegistryProfile } from "./registryProfiles";

// One already retained official public extract, not an arbitrary caller URL or
// a mutable government-match flag. Supporting another extract needs review.
export const SAM_SNAPSHOT = {
  schema: "sam_public_v2_20260802", sourceAsOf: "2026-08-02",
  archiveSha256: "2cd22d90f33ceea66a975efe6536a36d489e6a7b4dd9cdaccd9b506fa07f0bea",
  archiveMember: "SAM_PUBLIC_UTF-8_MONTHLY_V2_20260802.dat",
  sourceUrl: "https://sam.gov/data-services", records: 895429,
} as const;
type Attestation = { taskId: string; reviewedAt: string; evidenceSha256: string };
export type RegistrySamCorroboration = {
  schema: typeof SAM_SNAPSHOT.schema; archiveSha256: string; archiveMember: string;
  lineNumber: number; sourceAsOf: string; observedAt: string;
  rawRow: string; rawRowSha256: string; canonicalIdentitySha256: string;
  addressComparison?: "explicit_terminal_floor_v1";
  nameComparison?: "explicit_retained_dba_v1";
  reader: Attestation; reviewer: Attestation;
};
type Company = { id: string; netsuite_internal_id: string; name: string; domain?: string | null; website_raw?: string | null };
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const clean = (v: unknown, max = 200): v is string => typeof v === "string" && Boolean(v.trim()) && v.length <= max && !/[\u0000-\u001f]/.test(v);
const words = (v: string) => v.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, " ").trim();
const iso = (v: unknown): v is string => typeof v === "string" && /T.+(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
function host(value: string | null | undefined): string | null {
  if (!value || /\s/.test(value)) return null;
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`), h = u.hostname.toLowerCase().replace(/^www\./, "");
    if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(h)
      || /^\d+(?:\.\d+){3}$/.test(h) || ["facebook.com", "linkedin.com", "instagram.com", "youtube.com", "twitter.com", "x.com", "wixsite.com", "wordpress.com"].some(x => h === x || h.endsWith(`.${x}`))) return null;
    return h;
  } catch { return null; }
}

/** Binds the current server-loaded identity, without adding SAM to its addresses. */
export function registrySamCanonicalHash(company: Company, context: CompanyIdentityContext): string {
  return sha(stableRegistryJson({ companyId: company.id, internalId: company.netsuite_internal_id, name: company.name,
    domain: host(company.domain || company.website_raw), aliases: [...context.aliases].sort(),
    addresses: context.addresses.map(a => ({ ...a, capturedAt: iso(a.capturedAt) ? new Date(a.capturedAt).toISOString() : a.capturedAt })) }));
}
export function registrySamEvidenceHash(row: RegistryFinding, proof: Omit<RegistrySamCorroboration, "reader" | "reviewer">): string {
  return sha(stableRegistryJson({ companyId: row.companyId, internalId: row.internalId,
    contentHash: registryContentHash(row.profile, row.sourceUrl, row.detail),
    evidenceSha256: sha(row.evidence), observedAt: row.profile.observedAt, proof }));
}

/** Authenticated actual readers attest full row/target/identity/analysis review
 * and exact archive inclusion. Hashes verify integrity, not authenticity or that
 * two task IDs represent different humans. This is the existing agent trust
 * boundary; no caller verified flag or source URL establishes admission. */
export function parseRegistrySamCorroboration(raw: unknown, row: RegistryFinding, now = new Date()): RegistrySamCorroboration {
  const keys = ["schema", "archiveSha256", "archiveMember", "lineNumber", "sourceAsOf", "observedAt", "rawRow", "rawRowSha256", "canonicalIdentitySha256", "reader", "reviewer"];
  if (!object(raw) || Object.keys(raw).some(k => !keys.includes(k) && k !== "addressComparison" && k !== "nameComparison") || keys.some(k => !(k in raw))
    || "addressComparison" in raw && raw.addressComparison !== "explicit_terminal_floor_v1"
    || "nameComparison" in raw && raw.nameComparison !== "explicit_retained_dba_v1"
    || raw.schema !== SAM_SNAPSHOT.schema || raw.archiveSha256 !== SAM_SNAPSHOT.archiveSha256
    || raw.archiveMember !== SAM_SNAPSHOT.archiveMember || raw.sourceAsOf !== SAM_SNAPSHOT.sourceAsOf
    || !Number.isInteger(raw.lineNumber) || Number(raw.lineNumber) < 2 || Number(raw.lineNumber) > SAM_SNAPSHOT.records + 1
    || typeof raw.rawRow !== "string" || raw.rawRow.length > 30000 || !hash(raw.rawRowSha256) || sha(raw.rawRow) !== raw.rawRowSha256
    || !hash(raw.canonicalIdentitySha256) || !iso(raw.observedAt) || Date.parse(raw.observedAt) < Date.parse(SAM_SNAPSHOT.sourceAsOf)
    || Date.parse(raw.observedAt) > now.getTime() + 60000) throw new Error("invalid retained SAM extract evidence");
  readSamRow(raw.rawRow);
  const { reader, reviewer, ...proof } = raw;
  const evidenceSha256 = registrySamEvidenceHash(row, proof as Omit<RegistrySamCorroboration, "reader" | "reviewer">);
  for (const a of [reader, reviewer]) {
    if (!object(a) || Object.keys(a).some(k => !["taskId", "reviewedAt", "evidenceSha256"].includes(k))
      || !clean(a.taskId, 160) || !/^\/?[a-zA-Z0-9][a-zA-Z0-9_./:-]*$/.test(a.taskId) || !iso(a.reviewedAt)
      || Date.parse(a.reviewedAt) < Math.max(Date.parse(raw.observedAt), Date.parse(row.profile.observedAt)) || Date.parse(a.reviewedAt) > now.getTime() + 60000
      || now.getTime() - Date.parse(a.reviewedAt) > 7 * 86400000 || a.evidenceSha256 !== evidenceSha256)
      throw new Error("SAM review does not bind exact publication and identity evidence");
  }
  if ((reader as Attestation).taskId === (reviewer as Attestation).taskId) throw new Error("SAM evidence requires independent review");
  return raw as RegistrySamCorroboration;
}
function readSamRow(raw: string) {
  // Retain and hash the original LF or CRLF too. No trimmed/reconstructed CSV,
  // omitted second line, or mailing-address substitution is accepted.
  const record = raw.replace(/\r?\n$/, "");
  if (/[\u0000-\u001f]/.test(record)) throw new Error("invalid SAM original row framing");
  const f = record.split("|");
  // A retained row may have no CAGE. UEI and every identity/provenance gate remain required.
  if (f.length !== 142 || f[141] !== "!end" || !/^[A-Z0-9]{12}$/.test(f[0]) || !/^(?:[A-Z0-9]{5})?$/.test(f[3])
    || f[5] !== "A" || !clean(f[11]) || !clean(f[15]) || f[16].length > 200 || !clean(f[17])
    || !/^[A-Z]{2}$/.test(f[18]) || !/^\d{5}$/.test(f[19]) || !/^(?:\d{4})?$/.test(f[20]) || f[21] !== "USA" || !host(f[26]))
    throw new Error("SAM requires the complete active-snapshot US physical record");
  return { uei: f[0], cage: f[3], legalName: f[11], dbaName: f[12], website: f[26], statusAsOfSnapshot: f[5],
    updatedDateRaw: f[9], expirationDateRaw: f[8],
    physicalAddress: { addressLine1: f[15], addressLine2: f[16], city: f[17], state: f[18], postalCode: f[19] + (f[20] ? `-${f[20]}` : ""), countryCode: "US" as const } };
}

export function verifyRegistrySam(row: RegistryFinding, raw: unknown, company: Company, context: CompanyIdentityContext, now = new Date()): NonNullable<RegistryProfile["verification"]> {
  const proof = parseRegistrySamCorroboration(raw, row, now), sam = readSamRow(proof.rawRow), target = row.profile.identity;
  if (company.id !== row.companyId || company.netsuite_internal_id !== row.internalId
    || proof.canonicalIdentitySha256 !== registrySamCanonicalHash(company, context)) throw new Error("SAM canonical identity changed");
  const canonicalHost = host(company.domain || company.website_raw);
  if (!canonicalHost || canonicalHost !== host(sam.website)) throw new Error("SAM official domain does not exactly match canonical domain");
  const explicitDba = proof.nameComparison === "explicit_retained_dba_v1";
  if (explicitDba) {
    // A UCC debtor may be recorded under the complete explicit SAM DBA. Keep
    // that role separate from SAM's legal operator; never drop a name token or
    // legal suffix. The canonical brand, original debtor and DBA must all agree.
    if (row.profile.dataset !== "co_ucc" || !clean(sam.dbaName) || !normalizedDba(sam.dbaName)
      || normalizedDba(company.name) !== normalizedDba(sam.dbaName)
      || normalizedDba(target.legalName) !== normalizedDba(sam.dbaName))
      throw new Error("SAM explicit DBA requires exact canonical brand and recorded UCC debtor name");
  } else if (!sameRegistryLegalName(sam.legalName, target.legalName)) throw new Error("SAM and target registry legal operators differ");
  const compatible = (name: string) => sameRegistryLegalName(name, sam.legalName) || Boolean(sam.dbaName && words(name) === words(sam.dbaName));
  if (context.aliases.some(name => !compatible(name))
    || /\b(?:incorporated|inc|corporation|corp|limited|ltd|llc|llp|pllc|lp|pc)\.?$/i.test(company.name.trim()) && !compatible(company.name))
    throw new Error("SAM cannot override a known canonical legal operator");
  const address = sam.physicalAddress, targetZip = target.postalCode.replace(/-/g, ""), samZip = address.postalCode.replace(/-/g, "");
  if ((target.countryCode ?? "US") !== "US" || target.state !== address.state || !target.city || words(target.city) !== words(address.city)
    || targetZip.slice(0, 5) !== samZip.slice(0, 5) || targetZip.length === 9 && samZip.length === 9 && targetZip !== samZip
    || !(sameRegistryStreet({ ...target, countryCode: "US" }, address)
      || proof.addressComparison === "explicit_terminal_floor_v1" && sameRegistryTerminalFloor({ ...target, countryCode: "US" }, address)))
    throw new Error("SAM full physical address does not match registry address");
  const { reader, reviewer, ...evidence } = proof;
  return { method: "reviewed_sam_domain_legal_address", verifiedAt: now.toISOString(), sourceIds: [`sam:${sam.uei}:${proof.rawRowSha256}`],
    sam: { ...evidence, ...sam, sourceUrl: SAM_SNAPSHOT.sourceUrl, reader, reviewer,
      evidenceSha256: registrySamEvidenceHash(row, evidence), comparison: explicitDba
        ? "exact_domain_explicit_dba_physical_address" : proof.addressComparison === "explicit_terminal_floor_v1"
          ? "exact_domain_legal_physical_address_explicit_terminal_floor_v1" : "exact_domain_legal_physical_address",
      ...(explicitDba ? { targetNameRole: "sam_dba", targetRecordedName: target.legalName } : {}),
      canonicalAddresses: context.addresses, scope: explicitDba
        ? "Exact retained SAM DBA and recorded UCC debtor name association at the full physical address. SAM legal operator and target recorded name remain distinct; no legal-name equivalence, current registration, debt or company-address mutation is asserted."
        : "SAM registration and address as of the extract date; no current registration or company-address mutation." } };
}
