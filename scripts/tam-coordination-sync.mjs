#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const COORDINATION_SYNC_SCHEMA = "tam-coordination-sync-receipt";
export const COORDINATION_SYNC_VERSION = 2;
export const COORDINATION_APPLY_CONFIRMATION = "APPLY_EXACT_TAM_COORDINATION_SYNC";
export const DEFAULT_RUN_SLUG = "ars-bs-tam-current";

const coordinationPath = "/api/cron/tam-coordination";
const sha256Pattern = /^[0-9a-f]{64}$/;
const internalIdPattern = /^[0-9]+$/;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requireInteger(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function canonicalJsonBytes(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}

export function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function exactIdSort(left, right) {
  const lengthDelta = left.length - right.length;
  return lengthDelta || left.localeCompare(right);
}

function sameJson(left, right) {
  return canonicalJsonBytes(left) === canonicalJsonBytes(right);
}

function batches(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

async function readJson(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${filePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

async function readJsonLines(filePath, label) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read at ${filePath}: ${error.message}`);
  }
  const rows = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${label} has invalid JSON on line ${index + 1}: ${error.message}`);
    }
  }
  return rows;
}

async function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export function parseCoordinationArgs(argv) {
  const valueOptions = new Set([
    "mission",
    "live-state",
    "refresh-dir",
    "actor",
    "batch-size",
    "expected-companies-inserted",
    "confirm",
    "receipt",
    "base-url",
    "auth-mode",
  ]);
  const booleanOptions = new Set(["apply"]);
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      parsed._.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!(valueOptions.has(key) || booleanOptions.has(key))) {
      throw new Error(`Unknown option --${key}`);
    }
    if (Object.hasOwn(parsed, key)) throw new Error(`Option --${key} was supplied more than once`);
    if (booleanOptions.has(key)) {
      parsed[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`--${key} requires a value`);
    parsed[key] = next;
    index += 1;
  }
  if (parsed._.length > 1) throw new Error("At most one command may be supplied");
  return parsed;
}

function validateMembershipRow(row, index) {
  if (!isPlainObject(row)) throw new Error(`Membership line ${index + 1} must be an object`);
  const internalId = requireText(row.netsuiteInternalId, `Membership line ${index + 1} netsuiteInternalId`);
  if (!internalIdPattern.test(internalId)) {
    throw new Error(`Membership line ${index + 1} has a non-numeric exact Internal ID`);
  }
  if (!(row.membershipStatus === "new" || row.membershipStatus === "overlap")) {
    throw new Error(`Membership ${internalId} status must be new or overlap`);
  }
  if (!Array.isArray(row.tableRows) || !row.tableRows.length) {
    throw new Error(`Membership ${internalId} must preserve at least one saved-search row`);
  }
  if (!Array.isArray(row.sourceCoordinates)) {
    throw new Error(`Membership ${internalId} sourceCoordinates must be an array`);
  }
  if (
    !Number.isInteger(row.savedSearchRowCount)
    || row.savedSearchRowCount < 1
    || row.savedSearchRowCount !== row.tableRows.length
    || row.savedSearchRowCount !== row.sourceCoordinates.length
  ) {
    throw new Error(`Membership ${internalId} has inconsistent duplicate-row evidence counts`);
  }
  for (const [rowIndex, tableRow] of row.tableRows.entries()) {
    if (!isPlainObject(tableRow) || String(tableRow["INTERNAL ID"] ?? "").trim() !== internalId) {
      throw new Error(`Membership ${internalId} saved-search row ${rowIndex + 1} has a different Internal ID`);
    }
    const coordinate = row.sourceCoordinates[rowIndex];
    if (
      !isPlainObject(coordinate)
      || !Number.isInteger(coordinate.page)
      || coordinate.page < 1
      || !Number.isInteger(coordinate.row)
      || coordinate.row < 1
    ) {
      throw new Error(`Membership ${internalId} source coordinate ${rowIndex + 1} is invalid`);
    }
  }
  if (!sha256Pattern.test(String(row.tableRowsSha256 ?? ""))) {
    throw new Error(`Membership ${internalId} has an invalid tableRowsSha256`);
  }
  const actualRowsSha256 = sha256Text(canonicalJsonBytes(row.tableRows));
  if (actualRowsSha256 !== row.tableRowsSha256) {
    throw new Error(`Membership ${internalId} tableRowsSha256 does not match its canonical rows`);
  }
  return { ...row, netsuiteInternalId: internalId };
}

export async function loadCoordinationInputs({ missionPath, liveStatePath, refreshDir }) {
  const explicitMissionPath = path.resolve(requireText(missionPath, "--mission"));
  const explicitLiveStatePath = path.resolve(requireText(liveStatePath, "--live-state"));
  const explicitRefreshDir = path.resolve(requireText(refreshDir, "--refresh-dir"));
  const mission = await readJson(explicitMissionPath, "Mission");
  const liveState = await readJson(explicitLiveStatePath, "Live state");
  const manifestPath = path.join(explicitRefreshDir, "refresh_manifest.json");
  const membershipPath = path.join(explicitRefreshDir, "coordination_membership.jsonl");
  const removedPath = path.join(explicitRefreshDir, "coordination_removed_ids.json");
  const manifest = await readJson(manifestPath, "Refresh manifest");
  const membershipRaw = await readJsonLines(membershipPath, "Coordination membership");
  const removed = await readJson(removedPath, "Removed-ID evidence");

  const runSlug = requireText(mission.runSlug, "mission.runSlug");
  if (runSlug !== DEFAULT_RUN_SLUG) throw new Error(`Unexpected TAM run slug ${runSlug}`);
  if (liveState.runSlug !== runSlug) throw new Error("Live-state runSlug does not match the mission");
  const searchId = requireText(mission.membershipSource?.savedSearchId, "mission.membershipSource.savedSearchId");
  if (!internalIdPattern.test(searchId) || String(manifest.search_id) !== searchId) {
    throw new Error("Refresh manifest saved-search ID does not match the mission");
  }
  if (manifest.schema !== "tam-current-membership-refresh" || manifest.version !== 2) {
    throw new Error("Refresh manifest schema/version is not tam-current-membership-refresh v2");
  }
  const distinctCurrent = requireInteger(
    manifest.distinct_current_internal_ids,
    "manifest.distinct_current_internal_ids",
    1,
    100_000,
  );
  const sourceTotal = requireInteger(manifest.snapshot_total, "manifest.snapshot_total", 1, 1_000_000);
  const removedTotal = requireInteger(manifest.removed_internal_ids, "manifest.removed_internal_ids", 0, 100_000);
  const addedTotal = requireInteger(manifest.added_internal_ids, "manifest.added_internal_ids", 0, distinctCurrent);
  const overlapTotal = requireInteger(manifest.overlap_internal_ids, "manifest.overlap_internal_ids", 0, distinctCurrent);
  if (addedTotal + overlapTotal !== distinctCurrent) {
    throw new Error("Refresh manifest new/overlap counts do not cover current membership exactly");
  }
  const snapshotSha256 = String(manifest.pagination_snapshot_sha256 ?? "");
  if (!sha256Pattern.test(snapshotSha256)) throw new Error("Refresh manifest snapshot SHA-256 is invalid");
  if (manifest.saved_search_row_count !== sourceTotal || manifest.header_total_discrepancy !== 0) {
    throw new Error("Refresh manifest is not a complete, discrepancy-free saved-search capture");
  }
  const capture = liveState.capture;
  if (!isPlainObject(capture)) throw new Error("liveState.capture is required");
  if (
    Number(capture.distinctCurrentInternalIds) !== distinctCurrent
    || Number(capture.visibleRowsCaptured) !== sourceTotal
    || String(capture.snapshotSha256 ?? "") !== snapshotSha256
    || capture.finalDeltaRefreshRequired !== false
  ) {
    throw new Error("liveState.capture does not attest the exact supplied refresh manifest");
  }

  if (membershipRaw.length !== distinctCurrent) {
    throw new Error(`Membership has ${membershipRaw.length} exact IDs; manifest requires ${distinctCurrent}`);
  }
  const membership = membershipRaw.map(validateMembershipRow);
  const membershipIds = new Set();
  let savedSearchRows = 0;
  let newRows = 0;
  for (const row of membership) {
    if (membershipIds.has(row.netsuiteInternalId)) {
      throw new Error(`Membership repeats exact Internal ID ${row.netsuiteInternalId}`);
    }
    membershipIds.add(row.netsuiteInternalId);
    savedSearchRows += row.savedSearchRowCount;
    if (row.membershipStatus === "new") newRows += 1;
  }
  if (savedSearchRows !== sourceTotal) throw new Error("Membership duplicate rows do not sum to the saved-search total");
  if (newRows !== addedTotal) throw new Error("Membership new-ID count does not match the refresh manifest");

  if (!isPlainObject(removed) || !Array.isArray(removed.netsuiteInternalIds)) {
    throw new Error("Removed-ID evidence must contain netsuiteInternalIds");
  }
  if (removed.runSlug !== undefined && removed.runSlug !== runSlug) {
    throw new Error("Removed-ID evidence runSlug does not match the mission");
  }
  const removedIds = removed.netsuiteInternalIds.map((value, index) => {
    const internalId = requireText(value, `Removed ID ${index + 1}`);
    if (!internalIdPattern.test(internalId)) throw new Error(`Removed ID ${index + 1} is not numeric`);
    return internalId;
  });
  if (removedIds.length !== removedTotal || new Set(removedIds).size !== removedIds.length) {
    throw new Error("Removed-ID evidence is not the exact distinct manifest aggregate");
  }
  for (const internalId of removedIds) {
    if (membershipIds.has(internalId)) throw new Error(`Internal ID ${internalId} is both current and removed`);
  }

  const sortedCurrentIds = [...membershipIds].sort(exactIdSort);
  const sortedRemovedIds = [...removedIds].sort(exactIdSort);
  return {
    mission,
    liveState,
    manifest,
    membership,
    removed: {
      ids: sortedRemovedIds,
      reason: requireText(removed.reason, "removed.reason"),
    },
    runSlug,
    searchId,
    sourceTotal,
    snapshotSha256,
    currentIds: sortedCurrentIds,
    expected: {
      current: sortedCurrentIds.length,
      removed: sortedRemovedIds.length,
      new: addedTotal,
      overlap: overlapTotal,
    },
    hashes: {
      currentIds: sha256Text(canonicalJsonBytes(sortedCurrentIds)),
      removedIds: sha256Text(canonicalJsonBytes(sortedRemovedIds)),
      membershipEvidence: sha256Text(canonicalJsonBytes(
        membership
          .map((row) => ({
            netsuiteInternalId: row.netsuiteInternalId,
            membershipStatus: row.membershipStatus,
            savedSearchRowCount: row.savedSearchRowCount,
            tableRowsSha256: row.tableRowsSha256,
          }))
          .sort((left, right) => exactIdSort(left.netsuiteInternalId, right.netsuiteInternalId)),
      )),
    },
  };
}

export function createCoordinationApi({ baseUrl, agentToken, authMode = "agent-header", fetchImpl = fetch, timeoutMs = 30_000 }) {
  const base = requireText(baseUrl, "TAM_COORDINATION_BASE_URL or --base-url").replace(/\/+$/, "");
  const token = requireText(agentToken, "AGENT_TOKEN");
  if (!(authMode === "agent-header" || authMode === "bearer")) {
    throw new Error("--auth-mode must be agent-header or bearer");
  }

  async function request(method, relativePath, body) {
    const headers = {
      accept: "application/json",
      "x-agent-name": "codex",
      ...(authMode === "bearer"
        ? { authorization: `Bearer ${token}` }
        : { "x-agent-token": token }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    };
    const response = await fetchImpl(new URL(relativePath, base), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    if (!response.ok) {
      const detail = payload?.error || payload?.raw || response.statusText;
      const error = new Error(`${method} ${relativePath} failed (${response.status}): ${detail}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  return {
    get(relativePath) {
      return request("GET", relativePath);
    },
    post(body) {
      return request("POST", coordinationPath, body);
    },
  };
}

async function fetchRecordPartition(api, runSlug, current) {
  const records = [];
  let offset = 0;
  let expectedTotal = null;
  while (expectedTotal === null || offset < expectedTotal) {
    const query = new URLSearchParams({
      run: runSlug,
      view: "records",
      current: String(current),
      limit: "500",
      offset: String(offset),
    });
    const page = await api.get(`${coordinationPath}?${query}`);
    if (!Array.isArray(page?.records) || !Number.isInteger(page?.total)) {
      throw new Error(`Coordination ${current ? "current" : "removed"} readback has an invalid page`);
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) throw new Error("Coordination aggregate changed during paginated readback");
    if (!page.records.length && offset < expectedTotal) throw new Error("Coordination paginated readback ended early");
    records.push(...page.records);
    offset += page.records.length;
  }
  if (records.length !== expectedTotal) throw new Error("Coordination paginated readback count is inconsistent");
  return records;
}

export async function verifyCoordinationAggregate(api, inputs) {
  const [status, currentRecords, removedRecords] = await Promise.all([
    api.get(`${coordinationPath}?${new URLSearchParams({ run: inputs.runSlug, events: "0" })}`),
    fetchRecordPartition(api, inputs.runSlug, true),
    fetchRecordPartition(api, inputs.runSlug, false),
  ]);
  const currentById = new Map();
  for (const record of currentRecords) {
    const internalId = String(record?.netsuite_internal_id ?? "");
    if (!internalIdPattern.test(internalId) || currentById.has(internalId)) {
      throw new Error(`Current coordination readback has an invalid or duplicate ID ${internalId || "(blank)"}`);
    }
    currentById.set(internalId, record);
  }
  const removedIds = removedRecords.map((record) => String(record?.netsuite_internal_id ?? "")).sort(exactIdSort);
  if (new Set(removedIds).size !== removedIds.length || removedIds.some((id) => !internalIdPattern.test(id))) {
    throw new Error("Removed coordination readback has an invalid or duplicate exact ID");
  }
  const currentIds = [...currentById.keys()].sort(exactIdSort);
  if (!sameJson(currentIds, inputs.currentIds)) throw new Error("Current coordination IDs differ from exact membership");
  if (!sameJson(removedIds, inputs.removed.ids)) throw new Error("Removed coordination IDs differ from exact removal evidence");

  for (const expected of inputs.membership) {
    const actual = currentById.get(expected.netsuiteInternalId);
    if (
      actual?.is_current !== true
      || actual?.membership_status !== expected.membershipStatus
      || actual?.saved_search_row_count !== expected.savedSearchRowCount
      || actual?.table_rows_sha256 !== expected.tableRowsSha256
      || !sameJson(actual?.source_coordinates, expected.sourceCoordinates)
      || !sameJson(actual?.table_rows, expected.tableRows)
    ) {
      throw new Error(`Current coordination evidence differs for exact ID ${expected.netsuiteInternalId}`);
    }
  }
  for (const actual of removedRecords) {
    if (actual?.is_current !== false || actual?.membership_status !== "removed") {
      throw new Error(`Removed coordination state is invalid for exact ID ${actual?.netsuite_internal_id}`);
    }
  }

  const counts = status?.counts ?? {};
  if (
    Number(counts.current) !== inputs.expected.current
    || Number(counts.removed) !== inputs.expected.removed
    || Number(counts.records_total) !== inputs.expected.current + inputs.expected.removed
    || Number(counts.new) !== inputs.expected.new
    || Number(counts.overlap) !== inputs.expected.overlap
  ) {
    throw new Error("Coordination status counts differ from exact membership/removal aggregates");
  }
  if (
    status?.run?.slug !== inputs.runSlug
    || status?.run?.status !== "capturing"
    || String(status?.run?.search_id ?? "") !== inputs.searchId
    || !sameJson(status?.run?.mission, inputs.mission)
    || Number(status?.run?.source_total) !== inputs.sourceTotal
    || status?.run?.source_snapshot_sha256 !== inputs.snapshotSha256
  ) {
    throw new Error("Coordination run readback is not capturing with the exact mission/capture identity");
  }
  return {
    counts,
    currentIdsSha256: sha256Text(canonicalJsonBytes(currentIds)),
    removedIdsSha256: sha256Text(canonicalJsonBytes(removedIds)),
    membershipEvidenceSha256: sha256Text(canonicalJsonBytes(
      currentRecords
        .map((record) => ({
          netsuiteInternalId: record.netsuite_internal_id,
          membershipStatus: record.membership_status,
          savedSearchRowCount: record.saved_search_row_count,
          tableRowsSha256: record.table_rows_sha256,
        }))
        .sort((left, right) => exactIdSort(left.netsuiteInternalId, right.netsuiteInternalId)),
    )),
  };
}

export async function applyCoordinationSync({ api, inputs, actorKey = "codex", batchSize = 100, expectedCompaniesInserted = 0, onProgress = (_progress) => {} }) {
  await api.post({
    action: "bootstrap",
    runSlug: inputs.runSlug,
    searchId: inputs.searchId,
    mission: inputs.mission,
    status: "capturing",
    sourceTotal: inputs.sourceTotal,
    sourceSnapshotSha256: inputs.snapshotSha256,
  });
  await api.post({
    action: "heartbeat",
    runSlug: inputs.runSlug,
    actorKey,
    status: "working",
    currentWork: `Syncing completed ARS BS TAM snapshot (${inputs.expected.current} current exact IDs)`,
    metadata: {
      client: "tam-coordination-sync",
      version: COORDINATION_SYNC_VERSION,
      checkpointUpdatedAt: inputs.liveState.updatedAt ?? null,
      capture: inputs.liveState.capture,
    },
  });

  let membershipSynced = 0;
  let companiesInserted = 0;
  for (const batch of batches(inputs.membership, batchSize)) {
    const result = await api.post({
      action: "membership",
      runSlug: inputs.runSlug,
      actorKey,
      rows: batch,
      sourceTotal: inputs.sourceTotal,
      sourceSnapshotSha256: inputs.snapshotSha256,
    });
    if (Number(result?.upserted) !== batch.length || Number(result?.distinctIds) !== batch.length) {
      throw new Error("Membership API did not acknowledge the exact submitted batch");
    }
    const batchInserted = Number(result?.companiesInserted);
    const batchUpdated = Number(result?.companiesUpdated);
    if (!Number.isInteger(batchInserted) || batchInserted < 0 || !Number.isInteger(batchUpdated) || batchUpdated < 0) {
      throw new Error("Membership API returned invalid company mutation counts");
    }
    companiesInserted += batchInserted;
    membershipSynced += batch.length;
    onProgress({ phase: "membership", completed: membershipSynced, total: inputs.membership.length });
    if (companiesInserted > expectedCompaniesInserted) {
      throw new Error(
        `Unexpected companiesInserted=${companiesInserted}; explicitly expected ${expectedCompaniesInserted}. Stopping before another batch.`,
      );
    }
  }
  if (companiesInserted !== expectedCompaniesInserted) {
    throw new Error(`companiesInserted=${companiesInserted}; explicitly expected ${expectedCompaniesInserted}`);
  }

  let removalsSynced = 0;
  for (const batch of batches(inputs.removed.ids, 500)) {
    const result = await api.post({
      action: "removed",
      runSlug: inputs.runSlug,
      actorKey,
      netsuiteInternalIds: batch,
      reason: inputs.removed.reason,
    });
    if (Number(result?.removed) !== batch.length) {
      throw new Error("Removed-membership API did not acknowledge the exact submitted batch");
    }
    removalsSynced += batch.length;
    onProgress({ phase: "removed", completed: removalsSynced, total: inputs.removed.ids.length });
  }

  const readback = await verifyCoordinationAggregate(api, inputs);
  if (
    readback.currentIdsSha256 !== inputs.hashes.currentIds
    || readback.removedIdsSha256 !== inputs.hashes.removedIds
    || readback.membershipEvidenceSha256 !== inputs.hashes.membershipEvidence
  ) {
    throw new Error("Coordination aggregate hashes differ after exact readback");
  }
  await api.post({
    action: "event",
    runSlug: inputs.runSlug,
    actorKey,
    kind: "snapshot.synced",
    summary: `Synced and exactly read back ${inputs.expected.current} current TAM IDs and ${inputs.expected.removed} removed IDs`,
    metadata: {
      sourceTotal: inputs.sourceTotal,
      sourceSnapshotSha256: inputs.snapshotSha256,
      currentIdsSha256: readback.currentIdsSha256,
      removedIdsSha256: readback.removedIdsSha256,
      membershipEvidenceSha256: readback.membershipEvidenceSha256,
      companiesInserted,
    },
  });
  await api.post({
    action: "heartbeat",
    runSlug: inputs.runSlug,
    actorKey,
    status: "working",
    currentWork: "Membership exactly reconciled; registering locally verified evidence locators serially",
    metadata: {
      client: "tam-coordination-sync",
      version: COORDINATION_SYNC_VERSION,
      checkpointUpdatedAt: inputs.liveState.updatedAt ?? null,
      capture: inputs.liveState.capture,
      readback,
    },
  });
  return { membershipSynced, removalsSynced, companiesInserted, readback };
}

function publicPlan(inputs, apply, expectedCompaniesInserted) {
  return {
    schema: COORDINATION_SYNC_SCHEMA,
    version: COORDINATION_SYNC_VERSION,
    mode: apply ? "apply" : "dry-run",
    runSlug: inputs.runSlug,
    searchId: inputs.searchId,
    sourceTotal: inputs.sourceTotal,
    sourceSnapshotSha256: inputs.snapshotSha256,
    expected: inputs.expected,
    expectedCompaniesInserted,
    hashes: inputs.hashes,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseCoordinationArgs(process.argv.slice(2));
  const command = args._[0] || "sync";
  if (command !== "sync") throw new Error("The only supported command is sync");
  const inputs = await loadCoordinationInputs({
    missionPath: requireText(args.mission, "--mission"),
    liveStatePath: requireText(args["live-state"], "--live-state"),
    refreshDir: requireText(args["refresh-dir"], "--refresh-dir"),
  });
  const apply = Boolean(args.apply);
  const expectedCompaniesInserted = requireInteger(
    args["expected-companies-inserted"] ?? 0,
    "--expected-companies-inserted",
    0,
    inputs.expected.current,
  );
  const plan = publicPlan(inputs, apply, expectedCompaniesInserted);
  console.log(JSON.stringify(plan, null, 2));
  if (!apply) return;
  if (args.confirm !== COORDINATION_APPLY_CONFIRMATION) {
    throw new Error(`Apply mode requires --confirm ${COORDINATION_APPLY_CONFIRMATION}`);
  }
  const receiptPath = path.resolve(requireText(args.receipt, "--receipt"));
  const batchSize = requireInteger(args["batch-size"] ?? 100, "--batch-size", 1, 1_000);
  const actorKey = requireText(args.actor ?? process.env.TAM_ACTOR_KEY ?? "codex", "--actor");
  const api = createCoordinationApi({
    baseUrl: args["base-url"] ?? process.env.TAM_COORDINATION_BASE_URL ?? process.env.APP_BASE_URL,
    agentToken: process.env.AGENT_TOKEN,
    authMode: args["auth-mode"] ?? "agent-header",
  });
  let receipt = {
    ...plan,
    startedAt,
    completedAt: null,
    stopReason: "external_blocker",
    result: null,
    error: null,
  };
  try {
    const result = await applyCoordinationSync({
      api,
      inputs,
      actorKey,
      batchSize,
      expectedCompaniesInserted,
      onProgress(progress) {
        console.log(`${progress.phase} ${progress.completed}/${progress.total}`);
      },
    });
    receipt = {
      ...receipt,
      completedAt: new Date().toISOString(),
      stopReason: "worklist_exhausted",
      result,
    };
    await atomicWriteJson(receiptPath, receipt);
    console.log(JSON.stringify({ ok: true, receiptPath, result }, null, 2));
  } catch (error) {
    receipt = {
      ...receipt,
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    await atomicWriteJson(receiptPath, receipt);
    throw error;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
