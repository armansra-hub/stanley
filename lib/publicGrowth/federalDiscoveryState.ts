import type { FederalSearchTarget, VerifiedFederalIdentity } from "./federalIdentity";
import { parseUsaspendingSearchAfter, usaspendingCursorField, type UsaspendingSearchCursor } from "./usaspendingCursor";

export type FederalDiscoveryCandidate = { id: string; name: string; uei: string | null };
export interface FederalDiscoverySourceCapture {
  version: 1;
  status: "pending" | "held";
  stage: "search" | "detail";
  reason: string;
  observationId: string | null;
  requestSha256: string | null;
  retainedJsonSha256: string | null;
  capturedAt: string | null;
}

export interface FederalDiscoveryContinuation {
  searchAfter?: UsaspendingSearchCursor | null;
  collection?: "contracts" | "idvs";
  version: 1;
  companyId: string;
  companyIdentity: string;
  searchEndDate: string;
  targets: FederalSearchTarget[];
  targetIndex: number;
  page: number;
  candidate: FederalDiscoveryCandidate | null;
  lastPageHash: string | null;
  candidateQueue?: FederalDiscoveryCandidate[];
  pendingPage?: { hasNext: boolean; pageHash: string; nextCursor?: UsaspendingSearchCursor };
  evaluatedRecipients?: string[];
  foundVerified?: boolean;
  /** Collection progress only. A hold is never a completed interpretation. */
  sourceCapture?: FederalDiscoverySourceCapture;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const FEDERAL_DISCOVERY_CONTINUATION_LIMIT = 1000;
export interface FederalDiscoveryCapacityHold {
  version: 1;
  status: "held";
  reason: "reviewed_journal_capacity_recovery_requires_manual_resume";
  operationId: string;
  journalId: string;
  companyIds: string[];
  evidenceSha256: string;
  readerTaskId: string;
  reviewerTaskId: string;
  heldAt: string;
}
/** Only the audited capacity-reconciliation transaction creates this stop. */
export function readFederalDiscoveryCapacityHold(cursor: Record<string, unknown>): FederalDiscoveryCapacityHold | null {
  const value = cursor.discoveryCapacityHold;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid discovery capacity hold");
  const row = value as FederalDiscoveryCapacityHold;
  const fields = ["version", "status", "reason", "operationId", "journalId", "companyIds", "evidenceSha256", "readerTaskId", "reviewerTaskId", "heldAt"];
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))
    || row.version !== 1 || row.status !== "held" || row.reason !== "reviewed_journal_capacity_recovery_requires_manual_resume"
    || !UUID.test(row.operationId) || !UUID.test(row.journalId) || row.operationId === row.journalId
    || !Array.isArray(row.companyIds) || row.companyIds.length < 1 || row.companyIds.length > 4
    || row.companyIds.some(id => typeof id !== "string" || !UUID.test(id)) || new Set(row.companyIds).size !== row.companyIds.length
    || !/^[0-9a-f]{64}$/.test(row.evidenceSha256)
    || ![row.readerTaskId, row.reviewerTaskId].every(value => typeof value === "string" && value.trim() && value.length <= 200)
    || row.readerTaskId === row.reviewerTaskId || typeof row.heldAt !== "string" || !Number.isFinite(Date.parse(row.heldAt))) {
    throw new Error("invalid discovery capacity hold fields");
  }
  return structuredClone(row);
}
const text = (value: unknown, max: number): value is string => typeof value === "string" && Boolean(value.trim()) && value.length <= max;
const nullableText = (value: unknown, max: number) => value === null || text(value, max);
function parseCandidate(value: unknown): FederalDiscoveryCandidate {
  const candidate = value as FederalDiscoveryCandidate;
  if (!candidate || !text(candidate.id, 500) || !text(candidate.name, 500)
    || (candidate.uei !== null && !/^[A-Z0-9]{12}$/i.test(candidate.uei))) throw new Error("invalid discovery candidate");
  return { id: candidate.id, name: candidate.name, uei: candidate.uei };
}
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
  if (row.collection !== undefined && row.collection !== "contracts" && row.collection !== "idvs") throw new Error("invalid discovery collection");
  const queue = row.candidateQueue;
  if (queue !== undefined && (!Array.isArray(queue) || queue.length > 100)) throw new Error("invalid discovery candidate queue");
  const candidates = queue?.map(parseCandidate);
  if (candidates?.length && (!candidate || !row.pendingPage)) throw new Error("discovery candidate queue lacks its current page");
  const pending = row.pendingPage;
  if (pending !== undefined && (!pending || typeof pending.hasNext !== "boolean" || !text(pending.pageHash, 64)
    || !candidate || pending.hasNext && row.searchAfter !== undefined && !pending.nextCursor)) throw new Error("invalid discovery pending page");
  const nextCursor = pending?.nextCursor === undefined ? undefined : parseUsaspendingSearchAfter(pending.nextCursor);
  if (pending?.nextCursor !== undefined && !nextCursor) throw new Error("invalid discovery next cursor");
  if (row.evaluatedRecipients !== undefined && (!Array.isArray(row.evaluatedRecipients) || row.evaluatedRecipients.length > 1000
    || row.evaluatedRecipients.some(key => !text(key, 510) || !/^(uei:|award:)/.test(key))
    || new Set(row.evaluatedRecipients).size !== row.evaluatedRecipients.length)) throw new Error("invalid discovery evaluated recipients");
  if (row.foundVerified !== undefined && typeof row.foundVerified !== "boolean") throw new Error("invalid discovery verified progress");
  const capture = row.sourceCapture;
  if (capture !== undefined) {
    const fields = ["version", "status", "stage", "reason", "observationId", "requestSha256", "retainedJsonSha256", "capturedAt"];
    if (!capture || typeof capture !== "object" || Array.isArray(capture) || Object.keys(capture).length !== fields.length
      || Object.keys(capture).some(key => !fields.includes(key)) || capture.version !== 1
      || !["pending", "held"].includes(capture.status) || !["search", "detail"].includes(capture.stage)
      || !text(capture.reason, 120) || (capture.observationId !== null && !UUID.test(capture.observationId))
      || [capture.requestSha256, capture.retainedJsonSha256].some(value => value !== null && !/^[0-9a-f]{64}$/.test(value))
      || (capture.capturedAt !== null && (!text(capture.capturedAt, 40) || !Number.isFinite(Date.parse(capture.capturedAt))))
      || ([capture.observationId, capture.requestSha256, capture.retainedJsonSha256, capture.capturedAt].filter(value => value === null).length % 4 !== 0)
      || (capture.status === "pending" && (!capture.observationId || capture.stage !== "search"))) {
      throw new Error("invalid discovery source capture");
    }
  }
  return { version: 1, companyId, companyIdentity: row.companyIdentity, searchEndDate: row.searchEndDate,
    targets, targetIndex: row.targetIndex, page: row.page, candidate: candidate === null ? null : parseCandidate(candidate), lastPageHash: row.lastPageHash,
    ...(candidates === undefined ? {} : { candidateQueue: candidates }),
    ...(pending === undefined ? {} : { pendingPage: { hasNext: pending.hasNext, pageHash: pending.pageHash, ...(nextCursor ? { nextCursor } : {}) } }),
    ...(row.evaluatedRecipients === undefined ? {} : { evaluatedRecipients: [...row.evaluatedRecipients] }),
    ...(row.foundVerified === undefined ? {} : { foundVerified: row.foundVerified }),
    ...(capture === undefined ? {} : { sourceCapture: { ...capture } }),
    ...(row.collection === undefined ? {} : { collection: row.collection }),
    ...usaspendingCursorField(row) };
}

export function readFederalDiscoveryContinuations(cursor: Record<string, unknown>): Record<string, FederalDiscoveryContinuation> {
  const raw = cursor.discoveryContinuations ?? {};
  const hold = readFederalDiscoveryCapacityHold(cursor);
  const bound = FEDERAL_DISCOVERY_CONTINUATION_LIMIT + (hold?.companyIds.length ?? 0);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length > bound
    || hold?.companyIds.some(id => !Object.prototype.hasOwnProperty.call(raw, id))) throw new Error("invalid discovery continuation queue");
  return Object.fromEntries(Object.entries(raw).map(([id, value]) => [id, parseFederalDiscoveryContinuation(value, id)]));
}
