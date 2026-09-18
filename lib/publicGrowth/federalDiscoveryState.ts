import type { FederalSearchTarget, VerifiedFederalIdentity } from "./federalIdentity";

export interface FederalDiscoveryContinuation {
  version: 1;
  companyId: string;
  companyIdentity: string;
  searchEndDate: string;
  targets: FederalSearchTarget[];
  targetIndex: number;
  page: number;
  candidate: { id: string; name: string; uei: string | null } | null;
  lastPageHash: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
function identity(value: unknown): VerifiedFederalIdentity | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery identity");
  const row = value as VerifiedFederalIdentity;
  if (!UUID.test(row.entityId) || !text(row.legalName, 500) || !nullableText(row.dbaName, 500)
      || !nullableText(row.uei, 100) || !nullableText(row.recipientId, 500) || (!row.uei && !row.recipientId)) {
    throw new Error("invalid discovery identity fields");
  }
  return { entityId: row.entityId, legalName: row.legalName, dbaName: row.dbaName, uei: row.uei, recipientId: row.recipientId };
}
/** Validate persisted state before any provider request or enrollment write. */
export function parseFederalDiscoveryContinuation(value: unknown, companyId: string): FederalDiscoveryContinuation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery continuation");
  const row = value as FederalDiscoveryContinuation;
  if (row.version !== 1 || row.companyId !== companyId || !UUID.test(row.companyId) || !text(row.companyIdentity, 4000)
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.searchEndDate) || !Number.isFinite(Date.parse(row.searchEndDate))
      || new Date(row.searchEndDate).toISOString().slice(0, 10) !== row.searchEndDate
      || !Array.isArray(row.targets) || row.targets.length < 1 || row.targets.length > 300
      || !Number.isInteger(row.targetIndex) || row.targetIndex < 0 || row.targetIndex >= row.targets.length
      || !Number.isInteger(row.page) || row.page < 1 || row.page > 10000 || !nullableText(row.lastPageHash, 64)) {
    throw new Error("invalid discovery continuation fields");
  }
  const targets = row.targets.map((target) => {
    if (!target || !text(target.query, 500)) throw new Error("invalid discovery query target");
    return { query: target.query, identity: identity(target.identity) };
  });
  const candidate = row.candidate;
  if (candidate !== null && (!candidate || !text(candidate.id, 500) || !text(candidate.name, 500)
      || (candidate.uei !== null && !/^[A-Z0-9]{12}$/i.test(candidate.uei)))) throw new Error("invalid discovery candidate");
  return { version: 1, companyId, companyIdentity: row.companyIdentity, searchEndDate: row.searchEndDate,
    targets, targetIndex: row.targetIndex, page: row.page, candidate: candidate ? { ...candidate } : null, lastPageHash: row.lastPageHash };
}

export function readFederalDiscoveryContinuations(cursor: Record<string, unknown>): Record<string, FederalDiscoveryContinuation> {
  const raw = cursor.discoveryContinuations ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > 1000) throw new Error("invalid discovery continuation queue");
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, parseFederalDiscoveryContinuation(value, id)]));
}
