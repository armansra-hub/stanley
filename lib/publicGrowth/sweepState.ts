import "server-only";
import { advanceCursorOffset } from "@/lib/cron/rotation";
import { serviceClient } from "@/lib/supabase/server";
import { parseSubawardPartitions, subawardDateMillis, SUBAWARD_HISTORY_START, type SubawardSearchWindow } from "./subawardPartitions";
import { usaspendingCursorField, type UsaspendingSearchCursor } from "./usaspendingCursor";

export interface PublicGrowthSweepLease {
  source: string;
  offset: number;
  batchSize: number;
  managed: boolean;
  cursor: Record<string, unknown>;
  token: string | null;
  leaseUntil: string | null;
}

export interface PublicGrowthSweepResult {
  checked: number;
  mainChecked?: number;
  retryChecked?: number;
  stored?: number;
  historiesCompleted?: number;
  historiesIncomplete?: number;
  opportunityProgress?: Record<string, unknown>;
  nextOffset?: number;
  done?: boolean;
  triggers?: number;
  matched?: number;
  matches?: number;
  observed?: number;
  errors?: number;
  /** Retry-only completions persist state without moving the main source page. */
  advanceCursor?: boolean;
  /** Fenced JSON fields merged into the source cursor by the completion RPC. */
  cursorPatch?: Record<string, unknown>;
  mode?: "main" | "retry" | "main+retry" | "public_bulk_bounded";
  retryQueued?: number;
  retryRemaining?: number;
  retryDeadLettered?: string[];
  awardContinuationsQueued?: number;
}

/** Sixty-second fencing margin beyond the route's 300-second runtime ceiling. */
export const PUBLIC_GROWTH_LEASE_SECONDS = 360;

/**
 * Recurring readers fetch one lookahead row. That makes an exact final batch
 * (for example 10 of 10) terminal immediately instead of spending another day
 * on an empty request before the managed cursor wraps.
 */
export function takeRecurringBatch<T>(rows: T[], limit: number): { rows: T[]; done: boolean } {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("recurring batch limit must be positive");
  return { rows: rows.slice(0, limit), done: rows.length <= limit };
}

export function stableIdPageDecision(input: {
  page: number;
  passFoundNew: boolean;
  seenIds: string[];
  pageIds: string[];
  hasNext: boolean;
}): { nextId: string | null; page: number; passFoundNew: boolean; done: boolean } {
  const seen = new Set(input.seenIds);
  const nextId = input.pageIds.find((id) => !seen.has(id)) ?? null;
  if (nextId) return { nextId, page: input.page, passFoundNew: true, done: false };
  if (input.hasNext) return { nextId: null, page: input.page + 1, passFoundNew: input.passFoundNew, done: false };
  if (input.passFoundNew) return { nextId: null, page: 1, passFoundNew: false, done: false };
  return { nextId: null, page: input.page, passFoundNew: false, done: true };
}

export async function collectPublicGrowthKeysetPages<T extends { id: string }>(
  loadPage: (afterId: string | null, limit: number) => Promise<T[]>,
  options: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxRows = options.maxRows ?? 100_000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 5000) throw new Error("public-growth page size must be between 1 and 5000");
  if (!Number.isInteger(maxRows) || maxRows < pageSize) throw new Error("public-growth max rows must be at least one page");
  const rows: T[] = [];
  let afterId: string | null = null;
  while (true) {
    const page = await loadPage(afterId, pageSize);
    if (!Array.isArray(page) || page.length > pageSize) throw new Error("public-growth keyset loader returned an invalid page");
    if (!page.length) return rows;
    let prior = afterId;
    for (const row of page) {
      const id = String(row?.id ?? "");
      if (!id || (prior != null && id <= prior)) throw new Error("public-growth keyset page did not advance monotonically");
      prior = id;
    }
    if (rows.length + page.length > maxRows) throw new Error(`public-growth keyset load exceeded the supported ${maxRows}-row bound`);
    rows.push(...page);
    afterId = page[page.length - 1].id;
    if (page.length < pageSize) return rows;
  }
}

export const PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS = 3;

export interface PublicGrowthAwardContinuation {
  searchAfter?: UsaspendingSearchCursor | null;
  version: 1;
  recipientName: string;
  searchEndDate: string;
  searchPage: number;
  searchPassFoundNew: boolean;
  seenAwardIds: string[];
  entityId: string | null;
  uei: string | null;
  recipientId: string | null;
  pendingAwardId: string | null;
  transactionPage: number;
  transactionPassFoundNew: boolean;
  seenTransactionIds: string[];
  searchTargets?: import("./federalIdentity").FederalSearchTarget[];
  searchTargetIndex?: number;
  /** Excluded for this identity only; another verified entity may own the award. */
  ignoredAwardIds?: string[];
}

export interface PublicGrowthSubawardContinuation {
  searchAfter?: UsaspendingSearchCursor | null;
  version: 1;
  companyId: string;
  entityId: string;
  names: string[];
  nameIndex: number;
  searchEndDate: string;
  searchPage: number;
  searchPassFoundNew: boolean;
  seenSubawardIds: string[];
  /** Optional source-scoped date partitions; legacy cursors keep their full range. */
  searchWindows?: SubawardSearchWindow[];
  searchWindowIndex?: number;
  identities?: import("./federalIdentity").VerifiedFederalIdentity[];
  identityIndex?: number;
}

export interface PublicGrowthRetryEntry {
  companyId: string;
  failureAttempts: number;
  queuedAt: string;
  lastAttemptedAt: string;
  firstFailedAt: string | null;
  lastError: string | null;
  /** Exact frozen-search and per-award transaction checkpoint. */
  awardContinuation: PublicGrowthAwardContinuation | null;
  subawardContinuation?: PublicGrowthSubawardContinuation;
}

export interface PublicGrowthDeadLetter {
  companyId: string;
  totalFailures: number;
  firstFailedAt: string;
  lastFailedAt: string;
  lastError: string;
  deadLetteredAt: string;
  resolvedAt: string | null;
  occurrences: number;
  awardContinuation: PublicGrowthAwardContinuation | null;
  subawardContinuation?: PublicGrowthSubawardContinuation;
}

export interface PublicGrowthRetryState extends Record<string, unknown> {
  retryQueue: PublicGrowthRetryEntry[];
  deadLetters: PublicGrowthDeadLetter[];
  retryServedLast: boolean;
}

export interface PublicGrowthCompanyOutcome {
  companyId: string;
  status: string;
  error?: string;
  awardContinuation?: PublicGrowthAwardContinuation;
  awardDone?: boolean;
  subawardContinuation?: PublicGrowthSubawardContinuation;
  subawardDone?: boolean;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function exactTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return new Date(value).toISOString();
}

function exactCompanyId(value: unknown, label: string): string {
  const id = String(value ?? "");
  if (!uuidPattern.test(id)) throw new Error(`${label} must be a company UUID`);
  return id;
}

export function publicGrowthAfterCompanyId(cursor: Record<string, unknown>): string | null {
  return cursor.afterCompanyId == null
    ? null
    : exactCompanyId(cursor.afterCompanyId, "public-growth afterCompanyId");
}

export function matchesFrozenPublicGrowthRecipient(
  frozen: { uei: string | null; recipientId: string | null },
  candidate: { uei: string | null; recipientId: string | null },
): boolean {
  if (frozen.uei && candidate.uei) return frozen.uei === candidate.uei;
  if (frozen.recipientId && candidate.recipientId) return frozen.recipientId === candidate.recipientId;
  return false;
}

function exactFailure(value: unknown, label: string): string {
  const message = String(value ?? "").trim();
  if (!message) throw new Error(`${label} must not be blank`);
  return message.slice(0, 1000);
}

function boundedString(value: unknown, label: string, max = 500): string {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new Error(`${label} must be between 1 and ${max} characters`);
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function uniqueStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 25_000) throw new Error(`${label} must be an array with at most 25000 entries`);
  const rows = value.map((row, index) => boundedString(row, `${label}[${index}]`));
  if (new Set(rows).size !== rows.length) throw new Error(`${label} must not contain duplicates`);
  return rows;
}

function optionalAwardContinuation(value: unknown, label: string): PublicGrowthAwardContinuation | undefined {
  if (value === undefined || value === null) return undefined;
  const row = objectRecord(value);
  if (!row || row.version !== 1) throw new Error(`${label} must be a version 1 continuation`);
  const searchEndDate = boundedString(row.searchEndDate, `${label}.searchEndDate`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(searchEndDate) || !Number.isFinite(Date.parse(`${searchEndDate}T00:00:00.000Z`))) {
    throw new Error(`${label}.searchEndDate must be an ISO date`);
  }
  if (typeof row.searchPassFoundNew !== "boolean" || typeof row.transactionPassFoundNew !== "boolean") {
    throw new Error(`${label} pass flags must be boolean`);
  }
  return {
    version: 1,
    recipientName: boundedString(row.recipientName, `${label}.recipientName`),
    searchEndDate,
    searchPage: positiveInteger(row.searchPage, `${label}.searchPage`),
    searchPassFoundNew: row.searchPassFoundNew,
    seenAwardIds: uniqueStringArray(row.seenAwardIds, `${label}.seenAwardIds`),
    entityId: row.entityId == null ? null : exactCompanyId(row.entityId, `${label}.entityId`),
    uei: row.uei == null ? null : boundedString(row.uei, `${label}.uei`, 64),
    recipientId: row.recipientId == null ? null : boundedString(row.recipientId, `${label}.recipientId`, 200),
    pendingAwardId: row.pendingAwardId == null ? null : boundedString(row.pendingAwardId, `${label}.pendingAwardId`),
    transactionPage: positiveInteger(row.transactionPage, `${label}.transactionPage`),
    transactionPassFoundNew: row.transactionPassFoundNew,
    seenTransactionIds: uniqueStringArray(row.seenTransactionIds, `${label}.seenTransactionIds`),
    ...(row.ignoredAwardIds === undefined ? {} : { ignoredAwardIds: uniqueStringArray(row.ignoredAwardIds, `${label}.ignoredAwardIds`) }),
    ...awardTargets(row, label),
    ...usaspendingCursorField(row),
  };
}

function frozenIdentity(value: unknown, label: string): import("./federalIdentity").VerifiedFederalIdentity {
  const row = objectRecord(value);
  if (!row) throw new Error(`${label} must be an identity`);
  return { entityId: exactCompanyId(row.entityId, `${label}.entityId`),
    legalName: boundedString(row.legalName, `${label}.legalName`),
    dbaName: row.dbaName == null ? null : boundedString(row.dbaName, `${label}.dbaName`),
    uei: row.uei == null ? null : boundedString(row.uei, `${label}.uei`, 64),
    recipientId: row.recipientId == null ? null : boundedString(row.recipientId, `${label}.recipientId`, 200) };
}

function awardTargets(row: Record<string, unknown>, label: string): Pick<PublicGrowthAwardContinuation, "searchTargets" | "searchTargetIndex"> {
  if (row.searchTargets === undefined && row.searchTargetIndex === undefined) return {};
  if (!Array.isArray(row.searchTargets) || !row.searchTargets.length || row.searchTargets.length > 300) throw new Error(`${label} has invalid search targets`);
  const searchTargets = row.searchTargets.map((value, index) => {
    const target = objectRecord(value);
    if (!target) throw new Error(`${label} has invalid search target`);
    return { query: boundedString(target.query, `${label}.searchTargets[${index}].query`),
      identity: target.identity == null ? null : frozenIdentity(target.identity, `${label}.searchTargets[${index}].identity`) };
  });
  const searchTargetIndex = Number(row.searchTargetIndex);
  if (!Number.isInteger(searchTargetIndex) || searchTargetIndex < 0 || searchTargetIndex >= searchTargets.length) throw new Error(`${label} has invalid search target index`);
  return { searchTargets, searchTargetIndex };
}

function subawardIdentities(row: Record<string, unknown>, label: string): Pick<PublicGrowthSubawardContinuation, "identities" | "identityIndex"> {
  if (row.identities === undefined && row.identityIndex === undefined) return {};
  if (!Array.isArray(row.identities) || !row.identities.length || row.identities.length > 100) throw new Error(`${label} has invalid identities`);
  const identities = row.identities.map((value, index) => frozenIdentity(value, `${label}.identities[${index}]`));
  const identityIndex = Number(row.identityIndex);
  if (new Set(identities.map((identity) => identity.entityId)).size !== identities.length
      || !Number.isInteger(identityIndex) || identityIndex < 0 || identityIndex >= identities.length
      || identities[identityIndex].entityId !== row.entityId) throw new Error(`${label} has invalid identity index`);
  return { identities, identityIndex };
}

export function parsePublicGrowthSubawardContinuation(value: unknown, label = "subawardContinuation"): PublicGrowthSubawardContinuation {
  const row = objectRecord(value);
  if (!row || row.version !== 1) throw new Error(`${label} must be a version 1 continuation`);
  const names = uniqueStringArray(row.names, `${label}.names`);
  if (!names.length || names.length > 32) throw new Error(`${label}.names must contain 1-32 verified names`);
  const nameIndex = Number(row.nameIndex);
  if (!Number.isInteger(nameIndex) || nameIndex < 0 || nameIndex > names.length) throw new Error(`${label}.nameIndex is outside the frozen names`);
  const searchEndDate = boundedString(row.searchEndDate, `${label}.searchEndDate`, 10);
  if (subawardDateMillis(searchEndDate, `${label}.searchEndDate`) < subawardDateMillis(SUBAWARD_HISTORY_START, label)) throw new Error(`${label}.searchEndDate predates supported subaward history`);
  if (typeof row.searchPassFoundNew !== "boolean") throw new Error(`${label}.searchPassFoundNew must be boolean`);
  return {
    version: 1,
    companyId: exactCompanyId(row.companyId, `${label}.companyId`),
    entityId: exactCompanyId(row.entityId, `${label}.entityId`),
    names, nameIndex, searchEndDate,
    searchPage: positiveInteger(row.searchPage, `${label}.searchPage`),
    searchPassFoundNew: row.searchPassFoundNew,
    seenSubawardIds: uniqueStringArray(row.seenSubawardIds, `${label}.seenSubawardIds`),
    ...parseSubawardPartitions(row, searchEndDate, label),
    ...usaspendingCursorField(row),
    ...subawardIdentities(row, label),
  };
}

function subawardContinuationField(row: { companyId: unknown; subawardContinuation?: unknown }, label: string) {
  if (row.subawardContinuation == null) return {};
  const continuation = parsePublicGrowthSubawardContinuation(row.subawardContinuation, `${label}.subawardContinuation`);
  if (continuation.companyId !== row.companyId) throw new Error(`${label} continuation belongs to another company`);
  return { subawardContinuation: continuation };
}

function hasPendingHistory(row: PublicGrowthCompanyOutcome): boolean {
  return row.awardDone === false || row.subawardDone === false;
}

function requireHistoryContinuation(row: PublicGrowthCompanyOutcome) {
  if (row.awardDone === false && row.awardContinuation === undefined) throw new Error(`partial award receipt lacks a durable continuation for ${row.companyId}`);
  if (row.subawardDone === false && row.subawardContinuation === undefined) throw new Error(`partial subaward receipt lacks a durable continuation for ${row.companyId}`);
}

function parseRetryEntry(value: unknown, label: string): PublicGrowthRetryEntry {
  const row = objectRecord(value);
  if (!row) throw new Error(`${label} must be an object`);
  const failureAttempts = Number(row.failureAttempts);
  if (!Number.isInteger(failureAttempts) || failureAttempts < 0 || failureAttempts >= PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS) {
    throw new Error(`${label}.failureAttempts must be between 0 and ${PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS - 1}`);
  }
  const lastError = row.lastError == null ? null : exactFailure(row.lastError, `${label}.lastError`);
  const firstFailedAt = row.firstFailedAt == null ? null : exactTimestamp(row.firstFailedAt, `${label}.firstFailedAt`);
  if ((failureAttempts === 0) !== (lastError === null && firstFailedAt === null)) {
    throw new Error(`${label} failure count, timestamp, and error must agree`);
  }
  return {
    companyId: exactCompanyId(row.companyId, `${label}.companyId`),
    failureAttempts,
    queuedAt: exactTimestamp(row.queuedAt, `${label}.queuedAt`),
    lastAttemptedAt: exactTimestamp(row.lastAttemptedAt, `${label}.lastAttemptedAt`),
    firstFailedAt,
    lastError,
    awardContinuation: optionalAwardContinuation(row.awardContinuation, `${label}.awardContinuation`) ?? null,
    ...subawardContinuationField(row as { companyId: unknown; subawardContinuation?: unknown }, label),
  };
}

function parseDeadLetter(value: unknown, label: string): PublicGrowthDeadLetter {
  const row = objectRecord(value);
  if (!row) throw new Error(`${label} must be an object`);
  const totalFailures = Number(row.totalFailures);
  const occurrences = Number(row.occurrences);
  if (!Number.isInteger(totalFailures) || totalFailures < PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS) {
    throw new Error(`${label}.totalFailures must be at least ${PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS}`);
  }
  if (!Number.isInteger(occurrences) || occurrences < 1) {
    throw new Error(`${label}.occurrences must be positive`);
  }
  return {
    companyId: exactCompanyId(row.companyId, `${label}.companyId`),
    totalFailures,
    firstFailedAt: exactTimestamp(row.firstFailedAt, `${label}.firstFailedAt`),
    lastFailedAt: exactTimestamp(row.lastFailedAt, `${label}.lastFailedAt`),
    lastError: exactFailure(row.lastError, `${label}.lastError`),
    deadLetteredAt: exactTimestamp(row.deadLetteredAt, `${label}.deadLetteredAt`),
    resolvedAt: row.resolvedAt == null ? null : exactTimestamp(row.resolvedAt, `${label}.resolvedAt`),
    occurrences,
    awardContinuation: optionalAwardContinuation(row.awardContinuation, `${label}.awardContinuation`) ?? null,
    ...subawardContinuationField(row as { companyId: unknown; subawardContinuation?: unknown }, label),
  };
}

function assertUniqueIds<T extends { companyId: string }>(rows: T[], label: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.companyId)) throw new Error(`${label} repeats company ${row.companyId}`);
    seen.add(row.companyId);
  }
}

/** Malformed durable retry state is never silently overwritten. */
export function readPublicGrowthRetryState(cursor: Record<string, unknown>): PublicGrowthRetryState {
  const rawQueue = cursor.retryQueue ?? [];
  const rawDeadLetters = cursor.deadLetters ?? [];
  if (!Array.isArray(rawQueue) || !Array.isArray(rawDeadLetters)) {
    throw new Error("public-growth retryQueue and deadLetters must be arrays");
  }
  const retryQueue = rawQueue.map((row, index) => parseRetryEntry(row, `retryQueue[${index}]`));
  const deadLetters = rawDeadLetters.map((row, index) => parseDeadLetter(row, `deadLetters[${index}]`));
  assertUniqueIds(retryQueue, "retryQueue");
  assertUniqueIds(deadLetters, "deadLetters");
  if (cursor.retryServedLast !== undefined && typeof cursor.retryServedLast !== "boolean") {
    throw new Error("public-growth retryServedLast must be boolean");
  }
  return { retryQueue, deadLetters, retryServedLast: cursor.retryServedLast === true };
}

export function shouldServicePublicGrowthRetry(cursor: Record<string, unknown>): boolean {
  const state = readPublicGrowthRetryState(cursor);
  return state.retryQueue.length > 0 && !state.retryServedLast;
}

export function pendingPublicGrowthRetries(
  cursor: Record<string, unknown>,
  limit: number,
): PublicGrowthRetryEntry[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("public-growth retry limit must be between 1 and 10");
  }
  return readPublicGrowthRetryState(cursor).retryQueue.slice(0, limit);
}

function normalizedOutcome(row: PublicGrowthCompanyOutcome, label: string): PublicGrowthCompanyOutcome {
  const companyId = exactCompanyId(row.companyId, `${label}.companyId`);
  const status = String(row.status ?? "").trim();
  if (!status) throw new Error(`${label}.status is required`);
  if (row.awardDone !== undefined && typeof row.awardDone !== "boolean") {
    throw new Error(`${label}.awardDone must be boolean when present`);
  }
  if (row.subawardDone !== undefined && typeof row.subawardDone !== "boolean") throw new Error(`${label}.subawardDone must be boolean when present`);
  if (row.awardContinuation != null && row.subawardContinuation != null) throw new Error(`${label} cannot mix prime and subaward continuations`);
  return {
    companyId,
    status,
    ...(status === "error" ? { error: exactFailure(row.error, `${label}.error`) } : {}),
    ...(row.awardDone !== undefined ? { awardDone: row.awardDone } : {}),
    ...(row.subawardDone !== undefined ? { subawardDone: row.subawardDone } : {}),
    ...subawardContinuationField(row, label),
    ...(optionalAwardContinuation(row.awardContinuation, `${label}.awardContinuation`) !== undefined
      ? { awardContinuation: optionalAwardContinuation(row.awardContinuation, `${label}.awardContinuation`) }
      : {}),
  };
}

function resolveDeadLetter(
  deadLetters: PublicGrowthDeadLetter[],
  companyId: string,
  resolvedAt: string,
) {
  const index = deadLetters.findIndex((row) => row.companyId === companyId);
  if (index >= 0 && deadLetters[index].resolvedAt == null) {
    deadLetters[index] = { ...deadLetters[index], resolvedAt };
  }
}

/**
 * Advance the main page while binding every reported company error to an exact
 * durable retry entry. Existing dead letters remain audit history; a later
 * successful scheduled observation marks them resolved.
 */
export function queuePublicGrowthMainFailures(
  cursor: Record<string, unknown>,
  outcomes: PublicGrowthCompanyOutcome[],
  reportedErrors: number,
  now = new Date().toISOString(),
): { cursorPatch: PublicGrowthRetryState; queued: number; continuations: number } {
  const state = readPublicGrowthRetryState(cursor);
  const timestamp = exactTimestamp(now, "retry timestamp");
  const normalized = outcomes.map((row, index) => normalizedOutcome(row, `outcomes[${index}]`));
  assertUniqueIds(normalized, "public-growth outcomes");
  const failures = normalized.filter((row) => row.status === "error");
  if (!Number.isInteger(reportedErrors) || reportedErrors < 0 || failures.length !== reportedErrors) {
    throw new Error(`public-growth result reported ${reportedErrors} errors but bound ${failures.length} exact company receipts`);
  }
  const retryQueue: PublicGrowthRetryEntry[] = state.retryQueue.map((row) => ({ ...row }));
  let queued = 0;
  let continuations = 0;
  for (const row of normalized) {
    const existingIndex = retryQueue.findIndex((entry) => entry.companyId === row.companyId);
    if (row.status === "error") {
      if (existingIndex >= 0) continue;
      retryQueue.push({
        companyId: row.companyId,
        failureAttempts: 1,
        queuedAt: timestamp,
        lastAttemptedAt: timestamp,
        firstFailedAt: timestamp,
        lastError: row.error as string,
        awardContinuation: row.awardContinuation ?? null,
        ...subawardContinuationField(row, "main failure"),
      });
      queued++;
      continue;
    }
    if (row.status !== "error" && hasPendingHistory(row)) {
      requireHistoryContinuation(row);
      if (existingIndex >= 0) continue;
      retryQueue.push({
        companyId: row.companyId,
        failureAttempts: 0,
        queuedAt: timestamp,
        lastAttemptedAt: timestamp,
        firstFailedAt: null,
        lastError: null,
        awardContinuation: row.awardContinuation ?? null,
        ...subawardContinuationField(row, "main continuation"),
      });
      queued++;
      continuations++;
    }
  }
  const deadLetters = state.deadLetters.map((row) => ({ ...row }));
  for (const row of normalized) {
    if (row.status !== "error" && !hasPendingHistory(row)) {
      const existingIndex = retryQueue.findIndex((entry) => entry.companyId === row.companyId);
      if (existingIndex >= 0) retryQueue.splice(existingIndex, 1);
      resolveDeadLetter(deadLetters, row.companyId, timestamp);
    }
  }
  return {
    cursorPatch: { retryQueue, deadLetters, retryServedLast: false },
    queued,
    continuations,
  };
}

/** Apply exactly one retry attempt per planned ID; never loop within a request. */
export function applyPublicGrowthRetryOutcomes(
  cursor: Record<string, unknown>,
  planned: PublicGrowthRetryEntry[],
  outcomes: PublicGrowthCompanyOutcome[],
  now = new Date().toISOString(),
): { cursorPatch: PublicGrowthRetryState; deadLettered: string[]; errors: number } {
  const state = readPublicGrowthRetryState(cursor);
  const timestamp = exactTimestamp(now, "retry timestamp");
  const normalized = outcomes.map((row, index) => normalizedOutcome(row, `retryOutcomes[${index}]`));
  assertUniqueIds(normalized, "public-growth retry outcomes");
  const plannedIds = planned.map((row) => row.companyId);
  assertUniqueIds(planned, "planned public-growth retries");
  if (normalized.length !== planned.length
      || normalized.some((row) => !plannedIds.includes(row.companyId))) {
    throw new Error("public-growth retry outcomes do not match the exact planned company IDs");
  }
  const queueById = new Map(state.retryQueue.map((row) => [row.companyId, { ...row }]));
  for (const row of planned) {
    const current = queueById.get(row.companyId);
    if (!current
        || current.failureAttempts !== row.failureAttempts
        || current.queuedAt !== row.queuedAt
        || current.lastAttemptedAt !== row.lastAttemptedAt
        || current.firstFailedAt !== row.firstFailedAt
        || current.lastError !== row.lastError
        || JSON.stringify(current.awardContinuation) !== JSON.stringify(row.awardContinuation)
        || JSON.stringify(current.subawardContinuation) !== JSON.stringify(row.subawardContinuation)) {
      throw new Error(`planned retry no longer matches durable state for ${row.companyId}`);
    }
  }
  const deadLetters = state.deadLetters.map((row) => ({ ...row }));
  const deadLettered: string[] = [];
  let errors = 0;
  for (const outcome of normalized) {
    const current = queueById.get(outcome.companyId) as PublicGrowthRetryEntry;
    if (outcome.status !== "error" && hasPendingHistory(outcome)) {
      requireHistoryContinuation(outcome);
      queueById.set(outcome.companyId, {
        ...current,
        failureAttempts: 0,
        lastAttemptedAt: timestamp,
        firstFailedAt: null,
        lastError: null,
        awardContinuation: outcome.awardContinuation ?? null,
        ...subawardContinuationField(outcome, "retry continuation"),
      });
      continue;
    }
    if (outcome.status !== "error") {
      queueById.delete(outcome.companyId);
      resolveDeadLetter(deadLetters, outcome.companyId, timestamp);
      continue;
    }
    errors++;
    const failureAttempts = current.failureAttempts + 1;
    if (failureAttempts < PUBLIC_GROWTH_MAX_RETRY_ATTEMPTS) {
      queueById.set(outcome.companyId, {
        ...current,
        failureAttempts,
        lastAttemptedAt: timestamp,
        firstFailedAt: current.firstFailedAt ?? timestamp,
        lastError: outcome.error as string,
        awardContinuation: outcome.awardContinuation ?? current.awardContinuation,
        ...subawardContinuationField({ companyId: outcome.companyId, subawardContinuation: outcome.subawardContinuation ?? current.subawardContinuation }, "retry failure"),
      });
      continue;
    }
    queueById.delete(outcome.companyId);
    const priorIndex = deadLetters.findIndex((row) => row.companyId === outcome.companyId);
    const prior = priorIndex >= 0 ? deadLetters[priorIndex] : null;
    const deadLetter: PublicGrowthDeadLetter = {
      companyId: outcome.companyId,
      totalFailures: (prior?.totalFailures ?? 0) + failureAttempts,
      firstFailedAt: prior?.firstFailedAt ?? current.firstFailedAt ?? timestamp,
      lastFailedAt: timestamp,
      lastError: outcome.error as string,
      deadLetteredAt: timestamp,
      resolvedAt: null,
      occurrences: (prior?.occurrences ?? 0) + 1,
      awardContinuation: outcome.awardContinuation ?? current.awardContinuation,
      ...subawardContinuationField({ companyId: outcome.companyId, subawardContinuation: outcome.subawardContinuation ?? current.subawardContinuation }, "dead letter"),
    };
    if (priorIndex >= 0) deadLetters[priorIndex] = deadLetter;
    else deadLetters.push(deadLetter);
    deadLettered.push(outcome.companyId);
  }
  return {
    cursorPatch: {
      retryQueue: state.retryQueue
        .filter((row) => queueById.has(row.companyId))
        .map((row) => queueById.get(row.companyId) as PublicGrowthRetryEntry),
      deadLetters,
      retryServedLast: true,
    },
    deadLettered,
    errors,
  };
}

export class PublicGrowthSweepBusyError extends Error {
  constructor(public readonly source: string, public readonly retryAt: string | null) {
    super(`public-growth source ${source} already has an active sweep`);
    this.name = "PublicGrowthSweepBusyError";
  }
}

export class PublicGrowthSweepLeaseLostError extends Error {
  constructor(public readonly source: string) {
    super(`public-growth source ${source} no longer owns its sweep lease`);
    this.name = "PublicGrowthSweepLeaseLostError";
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function offsetFromCursor(cursor: unknown): number {
  if (!cursor || typeof cursor !== "object") return 0;
  const value = Number((cursor as Record<string, unknown>).offset ?? 0);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

/**
 * Explicit offsets are manual/recovery calls and do not mutate the scheduled
 * cursor. Scheduled calls omit offset and advance public_growth_sweep_state.
 */
export async function beginPublicGrowthSweep(
  source: string,
  batchSize: number,
  explicitOffset: number | null,
): Promise<PublicGrowthSweepLease> {
  if (explicitOffset != null) {
    return {
      source,
      offset: explicitOffset,
      batchSize,
      managed: false,
      cursor: { offset: explicitOffset },
      token: null,
      leaseUntil: null,
    };
  }

  const { data, error } = await serviceClient().rpc("acquire_public_growth_sweep_lease", {
    p_source: source,
    p_lease_seconds: PUBLIC_GROWTH_LEASE_SECONDS,
  });
  if (error) throw new Error(`public-growth lease acquisition failed for ${source}: ${error.message}`);
  const payload = objectRecord(data);
  if (!payload) throw new Error(`public-growth lease acquisition returned an invalid receipt for ${source}`);
  const leaseUntil = typeof payload.lease_until === "string" ? payload.lease_until : null;
  if (payload.acquired !== true) throw new PublicGrowthSweepBusyError(source, leaseUntil);
  const token = typeof payload.lease_token === "string" ? payload.lease_token : "";
  if (!token) throw new Error(`public-growth lease acquisition omitted its token for ${source}`);
  const cursor = objectRecord(payload.cursor) ?? {};
  return {
    source,
    offset: offsetFromCursor(cursor),
    batchSize,
    managed: true,
    cursor: { ...cursor },
    token,
    leaseUntil,
  };
}

export async function beginPublicGrowthRecoverySweep(
  source: string,
  batchSize: number,
  baseOffset: number,
): Promise<PublicGrowthSweepLease> {
  if (!Number.isInteger(baseOffset) || baseOffset < 0) throw new Error("public-growth recovery offset must be a non-negative integer");
  const stateSource = `${source}-recovery-${baseOffset}`;
  if (stateSource.length > 120) throw new Error("public-growth recovery source exceeds the supported length");
  const lease = await beginPublicGrowthSweep(stateSource, batchSize, null);
  const rawBase = lease.cursor.recoveryBaseOffset;
  if (rawBase == null) {
    if (lease.offset !== 0) throw new Error(`public-growth recovery ${stateSource} lacks its base-offset marker`);
    return {
      ...lease,
      offset: baseOffset,
      cursor: { ...lease.cursor, offset: baseOffset, recoveryBaseOffset: baseOffset },
    };
  }
  if (!Number.isInteger(Number(rawBase)) || Number(rawBase) !== baseOffset) {
    throw new Error(`public-growth recovery ${stateSource} has a mismatched base offset`);
  }
  return lease;
}

/** Exact-ID foundations never reuse the historical numeric-offset state keys. */
export async function beginPublicGrowthCompanyRecoverySweep(
  source: "usaspending" | "usaspending-subawards",
  companyId: string,
): Promise<PublicGrowthSweepLease> {
  const exactId = exactCompanyId(companyId, "recovery companyId").toLowerCase();
  const stateSource = `${source}-company-${exactId}`;
  const lease = await beginPublicGrowthSweep(stateSource, 1, null);
  const marker = lease.cursor.recoveryCompanyId;
  const retries = readPublicGrowthRetryState(lease.cursor);
  if ((marker != null && marker !== exactId)
      || (lease.cursor.recoverySource != null && lease.cursor.recoverySource !== source)
      || retries.retryQueue.some((row) => row.companyId !== exactId)
      || retries.deadLetters.some((row) => row.companyId !== exactId)
      || (lease.cursor.recoveryComplete === true && (lease.cursor.recoveryBlocked === true || retries.retryQueue.length > 0 || retries.deadLetters.some((row) => row.resolvedAt == null)))
      || (marker == null && (lease.offset !== 0 || lease.cursor.recoveryComplete != null
        || lease.cursor.recoveryBlocked != null || retries.retryQueue.length > 0 || retries.deadLetters.length > 0))) {
    await failPublicGrowthSweep(lease, new Error("exact recovery scope mismatch"));
    throw new Error("exact public-growth recovery state belongs to another scope");
  }
  return { ...lease, cursor: { ...lease.cursor, recoveryCompanyId: exactId, recoverySource: source } };
}

/** Read uncertain exact work without acquiring a lease or starting another step. */
export async function inspectPublicGrowthCompanyRecovery(
  source: "usaspending" | "usaspending-subawards",
  companyId: string,
) {
  const exactId = exactCompanyId(companyId, "inspection companyId").toLowerCase();
  const stateSource = `${source}-company-${exactId}`;
  const { data, error } = await serviceClient().from("public_growth_sweep_state")
    .select("cursor,last_started_at,last_succeeded_at,last_receipt,lease_until")
    .eq("source", stateSource).maybeSingle();
  if (error) throw new Error("exact recovery state read failed");
  if (!data) return { readOnly: true, found: false, companyId: exactId, recoveryStateKey: stateSource };
  const cursor = objectRecord(data.cursor) ?? {};
  const state = readPublicGrowthRetryState(cursor);
  if ((cursor.recoveryCompanyId != null && cursor.recoveryCompanyId !== exactId)
      || (cursor.recoverySource != null && cursor.recoverySource !== source)
      || state.retryQueue.some((row) => row.companyId !== exactId)
      || state.deadLetters.some((row) => row.companyId !== exactId)
      || (cursor.recoveryComplete === true && (cursor.recoveryBlocked === true || state.retryQueue.length > 0 || state.deadLetters.some((row) => row.resolvedAt == null)))
      || (cursor.recoveryCompanyId == null && (cursor.recoveryComplete != null || cursor.recoveryBlocked != null || state.retryQueue.length > 0 || state.deadLetters.length > 0))) {
    throw new Error("exact recovery state scope mismatch");
  }
  const receipt = objectRecord(data.last_receipt) ?? {};
  const safeReceipt = Object.fromEntries([
    "checked", "mainChecked", "retryChecked", "stored", "done", "errors", "completedAt",
    "retryQueued", "retryRemaining", "awardContinuationsQueued", "mode", "triggers", "matched", "historiesCompleted", "historiesIncomplete",
  ].filter((key) => receipt[key] !== undefined).map((key) => [key, receipt[key]]));
  return {
    readOnly: true, found: true, companyId: exactId, recoveryStateKey: stateSource,
    recoveryComplete: cursor.recoveryComplete === true,
    recoveryBlocked: cursor.recoveryBlocked === true,
    retryRemaining: state.retryQueue.length,
    unresolvedDeadLetters: state.deadLetters.filter((row) => row.resolvedAt == null).length,
    leaseUntil: data.lease_until, lastStartedAt: data.last_started_at,
    lastSucceededAt: data.last_succeeded_at, receipt: safeReceipt,
  };
}

/** Persist an exact in-run boundary while retaining the source's existing lease. */
export async function checkpointPublicGrowthSweep(lease: PublicGrowthSweepLease, patch: Record<string, unknown>): Promise<void> {
  if (!lease.managed || !lease.token) throw new PublicGrowthSweepLeaseLostError(lease.source);
  const cursor = structuredClone({ ...lease.cursor, ...patch, offset: lease.offset });
  const now = new Date().toISOString();
  const { data, error } = await serviceClient().from("public_growth_sweep_state")
    .update({ cursor, updated_at: now }).eq("source", lease.source).eq("lease_token", lease.token)
    .gt("lease_until", now).select("source").maybeSingle();
  if (error) throw new Error(`public-growth checkpoint failed for ${lease.source}: ${error.message}`);
  if (data?.source !== lease.source) throw new PublicGrowthSweepLeaseLostError(lease.source);
  lease.cursor = cursor;
}

export async function completePublicGrowthSweep(
  lease: PublicGrowthSweepLease,
  result: PublicGrowthSweepResult,
): Promise<number> {
  if (!lease.managed) return lease.offset;
  if (!lease.token) throw new PublicGrowthSweepLeaseLostError(lease.source);
  const nextOffset = result.advanceCursor === false
    ? lease.offset
    : advanceCursorOffset({
      currentOffset: lease.offset,
      checked: result.checked,
      batchSize: lease.batchSize,
      done: result.done === true,
      reportedNextOffset: result.nextOffset,
    });
  const now = new Date().toISOString();
  const nextCursor = { ...lease.cursor, ...(result.cursorPatch ?? {}), offset: nextOffset };
  const receipt = {
    checked: result.checked,
    mainChecked: result.mainChecked ?? (result.mode === "retry" ? 0 : result.checked),
    retryChecked: result.retryChecked ?? (result.mode === "retry" ? result.checked : 0),
    ...(result.stored !== undefined ? { stored: result.stored } : {}),
    ...(result.historiesCompleted !== undefined ? { historiesCompleted: result.historiesCompleted, historiesIncomplete: result.historiesIncomplete ?? 0 } : {}),
    ...(result.opportunityProgress !== undefined ? { opportunityProgress: result.opportunityProgress } : {}),
    nextOffset,
    done: result.done === true,
    triggers: result.triggers ?? 0,
    matched: result.matched ?? result.matches ?? result.observed ?? 0,
    errors: result.errors ?? 0,
    mode: result.mode ?? "main",
    retryQueued: result.retryQueued ?? 0,
    retryRemaining: result.retryRemaining ?? 0,
    retryDeadLettered: result.retryDeadLettered ?? [],
    awardContinuationsQueued: result.awardContinuationsQueued ?? 0,
    completedAt: now,
  };
  const { data, error } = await serviceClient().rpc("complete_public_growth_sweep_lease", {
    p_source: lease.source,
    p_lease_token: lease.token,
    p_cursor: nextCursor,
    p_receipt: receipt,
  });
  if (error) throw new Error(`public-growth cursor advance failed for ${lease.source}: ${error.message}`);
  if (data !== true) throw new PublicGrowthSweepLeaseLostError(lease.source);
  return nextOffset;
}

export async function failPublicGrowthSweep(lease: PublicGrowthSweepLease, error: unknown): Promise<boolean> {
  if (!lease.managed) return true;
  if (!lease.token) return false;
  const message = error instanceof Error ? error.message : String(error);
  const { data, error: rpcError } = await serviceClient().rpc("fail_public_growth_sweep_lease", {
    p_source: lease.source,
    p_lease_token: lease.token,
    p_error: message.slice(0, 1000),
  });
  if (rpcError) throw new Error(`public-growth failure receipt failed for ${lease.source}: ${rpcError.message}`);
  return data === true;
}
