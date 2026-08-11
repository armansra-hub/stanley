import "server-only";
import { advanceCursorOffset } from "@/lib/cron/rotation";
import { serviceClient } from "@/lib/supabase/server";

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
  mode?: "main" | "retry";
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
  };
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
  return {
    companyId,
    status,
    ...(status === "error" ? { error: exactFailure(row.error, `${label}.error`) } : {}),
    ...(row.awardDone !== undefined ? { awardDone: row.awardDone } : {}),
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
      });
      queued++;
      continue;
    }
    if (row.status !== "error" && row.awardDone === false) {
      if (row.awardContinuation === undefined) throw new Error(`partial award receipt lacks a durable continuation for ${row.companyId}`);
      if (existingIndex >= 0) continue;
      retryQueue.push({
        companyId: row.companyId,
        failureAttempts: 0,
        queuedAt: timestamp,
        lastAttemptedAt: timestamp,
        firstFailedAt: null,
        lastError: null,
        awardContinuation: row.awardContinuation,
      });
      queued++;
      continuations++;
    }
  }
  const deadLetters = state.deadLetters.map((row) => ({ ...row }));
  for (const row of normalized) {
    if (row.status !== "error" && row.awardDone !== false) {
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
        || JSON.stringify(current.awardContinuation) !== JSON.stringify(row.awardContinuation)) {
      throw new Error(`planned retry no longer matches durable state for ${row.companyId}`);
    }
  }
  const deadLetters = state.deadLetters.map((row) => ({ ...row }));
  const deadLettered: string[] = [];
  let errors = 0;
  for (const outcome of normalized) {
    const current = queueById.get(outcome.companyId) as PublicGrowthRetryEntry;
    if (outcome.status !== "error" && outcome.awardDone === false) {
      if (outcome.awardContinuation === undefined) throw new Error(`partial award retry lacks a durable continuation for ${outcome.companyId}`);
      queueById.set(outcome.companyId, {
        ...current,
        failureAttempts: 0,
        lastAttemptedAt: timestamp,
        firstFailedAt: null,
        lastError: null,
        awardContinuation: outcome.awardContinuation,
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
