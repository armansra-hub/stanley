#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import {
  canonicalJsonBytes,
  createCoordinationApi,
  DEFAULT_RUN_SLUG,
  sha256Text,
} from "./tam-coordination-sync.mjs";

export const LOCAL_EVIDENCE_SCHEMA = "tam-local-evidence-sync";
export const LOCAL_EVIDENCE_VERSION = 1;
export const LOCAL_EVIDENCE_EXPECTED_COUNT = 6_949;
export const LOCAL_EVIDENCE_EXPECTED_PAGES = 90_857;
export const LOCAL_EVIDENCE_EXPECTED_BYTES = 1_728_918_143;
export const LOCAL_EVIDENCE_APPLY_CONFIRMATION = "REGISTER_EXACT_LOCAL_TAM_EVIDENCE_6949";

const coordinationPath = "/api/cron/tam-coordination";
const internalIdPattern = /^[0-9]+$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const trustedPdfAuditPath = path.join(scriptDirectory, "tam_pdf_audit.py");

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function exactIdSort(left, right) {
  const lengthDelta = left.length - right.length;
  return lengthDelta || left.localeCompare(right);
}

function parsePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function normalizeTimestamp(value, label) {
  const text = requireText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function normalizeLocator(value) {
  return String(value ?? "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function resolvedPathsEqual(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function atomicWriteJson(filePath, value) {
  const target = path.resolve(filePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`State could not be read at ${filePath}: ${error.message}`);
  }
}

async function readSheetArtifact(filePath, label) {
  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (error) {
    throw new Error(`${label} could not be read at ${filePath}: ${error.message}`);
  }
  let workbook;
  try {
    workbook = XLSX.read(bytes, { type: "buffer", raw: true });
  } catch (error) {
    throw new Error(`${label} is not a readable spreadsheet: ${error.message}`);
  }
  if (workbook.SheetNames.length !== 1) throw new Error(`${label} must contain exactly one sheet`);
  return {
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      defval: "",
      raw: false,
    }),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function requireColumns(rows, columns, label) {
  if (!rows.length) throw new Error(`${label} is empty`);
  for (const column of columns) {
    if (!Object.hasOwn(rows[0], column)) throw new Error(`${label} is missing required column ${column}`);
  }
}

export async function runTrustedPdfAudit({ pythonPath, records, timeoutMs = 30 * 60_000 }) {
  const executable = path.resolve(requireText(pythonPath, "--python or TAM_PDF_PYTHON"));
  if (!Array.isArray(records) || !records.length) throw new Error("Trusted PDF audit requires records");
  const childEnvironment = Object.fromEntries(
    ["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  childEnvironment.PYTHONUTF8 = "1";
  const child = spawn(executable, [trustedPdfAuditPath], {
    cwd: scriptDirectory,
    env: childEnvironment,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputOverflow = null;
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 16 * 1024 * 1024) {
      outputOverflow = new Error("Trusted PDF audit stdout exceeded 16 MiB");
      child.kill();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 2 * 1024 * 1024) stderr.push(chunk);
  });
  const exitPromise = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  child.stdin.on("error", () => {
    // The process exit and bounded stderr below carry the actionable failure.
  });
  const timeout = setTimeout(() => child.kill(), timeoutMs);
  child.stdin.end(JSON.stringify({
    records: records.map((record) => ({
      netsuiteInternalId: record.netsuiteInternalId,
      pdfPath: record.pdfPath,
    })),
  }));
  const exit = await exitPromise.finally(() => clearTimeout(timeout));
  if (outputOverflow) throw outputOverflow;
  const stderrText = Buffer.concat(stderr).toString("utf8").trim();
  if (exit.code !== 0) {
    throw new Error(`Trusted PDF audit failed (${exit.code ?? exit.signal}): ${stderrText || "no detail"}`);
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.concat(stdout).toString("utf8"));
  } catch (error) {
    throw new Error(`Trusted PDF audit returned invalid JSON: ${error.message}`);
  }
  if (
    payload?.schema !== "tam-trusted-pdf-audit"
    || payload?.version !== 1
    || !Array.isArray(payload?.results)
    || payload.results.length !== records.length
  ) {
    throw new Error("Trusted PDF audit returned an invalid or incomplete result set");
  }
  return payload.results;
}

export function parseEvidenceArgs(argv) {
  const valueOptions = new Set([
    "membership",
    "inventory",
    "evidence-root",
    "state",
    "receipt",
    "actor",
    "confirm",
    "base-url",
    "auth-mode",
    "python",
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
    if (!(valueOptions.has(key) || booleanOptions.has(key))) throw new Error(`Unknown option --${key}`);
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
  if (parsed._.length) throw new Error("tam-local-evidence-sync does not accept a positional command");
  return parsed;
}

/**
 * @param {{
 *   membershipPath: string,
 *   inventoryPath: string,
 *   evidenceRoot: string,
 *   expectedCount?: number,
 *   pythonPath?: string,
 *   pdfAuditor?: (records: Array<Record<string, any>>) => Promise<Array<Record<string, any>>>,
 *   onProgress?: (progress: Record<string, any>) => void,
 * }} options
 */
export async function validateEvidenceCorpus({
  membershipPath,
  inventoryPath,
  evidenceRoot,
  expectedCount = LOCAL_EVIDENCE_EXPECTED_COUNT,
  pythonPath = undefined,
  pdfAuditor = undefined,
  onProgress = (_progress) => {},
}) {
  const resolvedMembershipPath = path.resolve(requireText(membershipPath, "--membership"));
  const resolvedInventoryPath = path.resolve(requireText(inventoryPath, "--inventory"));
  const resolvedEvidenceRoot = path.resolve(requireText(evidenceRoot, "--evidence-root"));
  const rootStats = await stat(resolvedEvidenceRoot).catch((error) => {
    throw new Error(`Evidence root could not be inspected: ${error.message}`);
  });
  if (!rootStats.isDirectory()) throw new Error("--evidence-root must be a directory");
  const realEvidenceRoot = await realpath(resolvedEvidenceRoot);

  const membershipArtifact = await readSheetArtifact(resolvedMembershipPath, "Membership");
  const inventoryArtifact = await readSheetArtifact(resolvedInventoryPath, "PDF inventory");
  const membershipRows = membershipArtifact.rows;
  const inventoryRows = inventoryArtifact.rows;
  requireColumns(membershipRows, ["Internal ID"], "Membership");
  requireColumns(inventoryRows, [
    "Internal ID",
    "Captured At UTC",
    "PDF Path",
    "PDF SHA256",
    "PDF Pages",
    "PDF Bytes",
    "Capture Metadata Path",
    "Capture Metadata SHA256",
    "Capture Snapshot SHA256",
  ], "PDF inventory");
  if (membershipRows.length !== expectedCount) {
    throw new Error(`Membership has ${membershipRows.length} entries; exactly ${expectedCount} are required`);
  }
  if (inventoryRows.length !== expectedCount) {
    throw new Error(`PDF inventory has ${inventoryRows.length} entries; exactly ${expectedCount} are required`);
  }

  const membershipIds = new Set();
  for (const [index, row] of membershipRows.entries()) {
    const internalId = requireText(row["Internal ID"], `Membership row ${index + 1} Internal ID`);
    if (!internalIdPattern.test(internalId)) throw new Error(`Membership row ${index + 1} Internal ID is not numeric`);
    if (membershipIds.has(internalId)) throw new Error(`Membership repeats exact Internal ID ${internalId}`);
    membershipIds.add(internalId);
  }

  const inventoryById = new Map();
  for (const [index, row] of inventoryRows.entries()) {
    const internalId = requireText(row["Internal ID"], `Inventory row ${index + 1} Internal ID`);
    if (!internalIdPattern.test(internalId)) throw new Error(`Inventory row ${index + 1} Internal ID is not numeric`);
    if (inventoryById.has(internalId)) throw new Error(`PDF inventory repeats exact Internal ID ${internalId}`);
    inventoryById.set(internalId, row);
  }
  const membershipIdList = [...membershipIds].sort(exactIdSort);
  const inventoryIdList = [...inventoryById.keys()].sort(exactIdSort);
  if (canonicalJsonBytes(membershipIdList) !== canonicalJsonBytes(inventoryIdList)) {
    throw new Error("Membership and PDF inventory exact-ID sets differ");
  }

  const candidates = [];
  for (const [index, internalId] of membershipIdList.entries()) {
    const row = inventoryById.get(internalId);
    const idDirectory = path.join(resolvedEvidenceRoot, "leads", internalId);
    const pdfPath = path.join(idDirectory, "print.pdf");
    const capturePath = path.join(idDirectory, "capture.json");
    if (!resolvedPathsEqual(requireText(row["PDF Path"], `Inventory ${internalId} PDF Path`), pdfPath)) {
      throw new Error(`Inventory ${internalId} PDF Path is not the exact <evidence-root>/leads/${internalId}/print.pdf path`);
    }
    if (!resolvedPathsEqual(requireText(row["Capture Metadata Path"], `Inventory ${internalId} Capture Metadata Path`), capturePath)) {
      throw new Error(`Inventory ${internalId} capture path is not the exact numeric-ID directory`);
    }
    const [realPdfPath, realCapturePath] = await Promise.all([
      realpath(pdfPath).catch((error) => { throw new Error(`Evidence ${internalId} PDF is missing: ${error.message}`); }),
      realpath(capturePath).catch((error) => { throw new Error(`Evidence ${internalId} capture.json is missing: ${error.message}`); }),
    ]);
    if (!pathIsWithin(realEvidenceRoot, realPdfPath) || !pathIsWithin(realEvidenceRoot, realCapturePath)) {
      throw new Error(`Evidence ${internalId} resolves outside the explicit evidence root`);
    }

    const inventoryPdfSha256 = requireText(row["PDF SHA256"], `Inventory ${internalId} PDF SHA256`);
    const inventoryCaptureSha256 = requireText(row["Capture Metadata SHA256"], `Inventory ${internalId} Capture Metadata SHA256`);
    const inventoryCaptureSnapshotSha256 = requireText(
      row["Capture Snapshot SHA256"],
      `Inventory ${internalId} Capture Snapshot SHA256`,
    );
    if (
      !sha256Pattern.test(inventoryPdfSha256)
      || !sha256Pattern.test(inventoryCaptureSha256)
      || !sha256Pattern.test(inventoryCaptureSnapshotSha256)
    ) {
      throw new Error(`Inventory ${internalId} contains an invalid lowercase SHA-256`);
    }
    const pageCount = parsePositiveInteger(row["PDF Pages"], `Inventory ${internalId} PDF Pages`);
    const byteCount = parsePositiveInteger(row["PDF Bytes"], `Inventory ${internalId} PDF Bytes`);
    const inventoryCapturedAt = normalizeTimestamp(row["Captured At UTC"], `Inventory ${internalId} Captured At UTC`);
    const captureBytes = await readFile(capturePath);
    const actualCaptureSha256 = createHash("sha256").update(captureBytes).digest("hex");
    if (actualCaptureSha256 !== inventoryCaptureSha256) {
      throw new Error(`Evidence ${internalId} capture.json SHA-256 differs from inventory`);
    }
    let capture;
    try {
      capture = JSON.parse(captureBytes.toString("utf8"));
    } catch (error) {
      throw new Error(`Evidence ${internalId} capture.json is invalid: ${error.message}`);
    }
    const locator = `leads/${internalId}/print.pdf`;
    const capturePageCount = parsePositiveInteger(capture?.pdf?.page_count, `Capture ${internalId} pdf.page_count`);
    const captureByteCount = parsePositiveInteger(capture?.pdf?.bytes, `Capture ${internalId} pdf.bytes`);
    const captureVerifiedAt = normalizeTimestamp(capture?.captured_at_utc, `Capture ${internalId} captured_at_utc`);
    if (
      capture?.status !== "verified"
      || String(capture?.internal_id ?? "") !== internalId
      || normalizeLocator(capture?.pdf?.path) !== locator
      || capture?.pdf?.sha256 !== inventoryPdfSha256
      || capturePageCount !== pageCount
      || captureByteCount !== byteCount
      || captureVerifiedAt !== inventoryCapturedAt
    ) {
      throw new Error(`Evidence ${internalId} capture metadata differs from its exact inventory entry`);
    }
    if (capture?.snapshot_sha256 !== inventoryCaptureSnapshotSha256) {
      throw new Error(`Evidence ${internalId} snapshot SHA-256 differs from inventory`);
    }
    candidates.push({
      ordinal: index + 1,
      netsuiteInternalId: internalId,
      pdfPath,
      locator,
      sha256: inventoryPdfSha256,
      pageCount,
      verifiedAt: captureVerifiedAt,
      bytes: byteCount,
      captureSha256: actualCaptureSha256,
      captureSnapshotSha256: inventoryCaptureSnapshotSha256,
    });
    onProgress({ phase: "metadata", completed: index + 1, total: membershipIdList.length, internalId });
  }

  const auditResults = pdfAuditor
    ? await pdfAuditor(candidates)
    : await runTrustedPdfAudit({ pythonPath, records: candidates });
  if (!Array.isArray(auditResults) || auditResults.length !== candidates.length) {
    throw new Error("Trusted PDF auditor did not return the exact candidate count");
  }
  const entries = [];
  for (const [index, candidate] of candidates.entries()) {
    const audit = auditResults[index];
    if (
      audit?.netsuiteInternalId !== candidate.netsuiteInternalId
      || audit?.sha256 !== candidate.sha256
      || Number(audit?.pageCount) !== candidate.pageCount
      || Number(audit?.bytes) !== candidate.bytes
      || !audit?.stableStat
    ) {
      throw new Error(`Evidence ${candidate.netsuiteInternalId} trusted PDF hash/page/stat audit differs from inventory/capture`);
    }
    const { pdfPath: _privatePath, ...entry } = candidate;
    entries.push(entry);
    onProgress({
      phase: "validate",
      completed: index + 1,
      total: candidates.length,
      internalId: candidate.netsuiteInternalId,
    });
  }

  const membershipFileSha256 = membershipArtifact.sha256;
  const inventoryFileSha256 = inventoryArtifact.sha256;
  const totalPdfBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
  const totalPdfPages = entries.reduce((total, entry) => total + entry.pageCount, 0);
  if (
    expectedCount === LOCAL_EVIDENCE_EXPECTED_COUNT
    && (totalPdfPages !== LOCAL_EVIDENCE_EXPECTED_PAGES || totalPdfBytes !== LOCAL_EVIDENCE_EXPECTED_BYTES)
  ) {
    throw new Error(
      `Trusted PDF aggregate is ${totalPdfPages} pages/${totalPdfBytes} bytes; expected ${LOCAL_EVIDENCE_EXPECTED_PAGES}/${LOCAL_EVIDENCE_EXPECTED_BYTES}`,
    );
  }
  const corpusSha256 = sha256Text(canonicalJsonBytes(entries.map((entry) => ({
    netsuiteInternalId: entry.netsuiteInternalId,
    locator: entry.locator,
    sha256: entry.sha256,
    pageCount: entry.pageCount,
    verifiedAt: entry.verifiedAt,
    bytes: entry.bytes,
    captureSha256: entry.captureSha256,
    captureSnapshotSha256: entry.captureSnapshotSha256,
  }))));
  return {
    runSlug: DEFAULT_RUN_SLUG,
    entries,
    expectedCount,
    membershipFileSha256,
    inventoryFileSha256,
    exactIdsSha256: sha256Text(canonicalJsonBytes(membershipIdList)),
    corpusSha256,
    totalPdfBytes,
    totalPdfPages,
  };
}

async function readExactCoordinationRecord(api, runSlug, internalId) {
  const query = new URLSearchParams({
    run: runSlug,
    view: "records",
    id: internalId,
    limit: "2",
    offset: "0",
  });
  const payload = await api.get(`${coordinationPath}?${query}`);
  if (!Array.isArray(payload?.records) || !Number.isInteger(payload?.total)) {
    throw new Error(`Evidence readback for ${internalId} has an invalid response`);
  }
  if (payload.total === 0 && payload.records.length === 0) return null;
  if (payload.total !== 1 || payload.records.length !== 1) {
    throw new Error(`Evidence readback for ${internalId} is ambiguous (${payload.total} records)`);
  }
  if (String(payload.records[0]?.netsuite_internal_id ?? "") !== internalId) {
    throw new Error(`Evidence readback returned a different exact Internal ID for ${internalId}`);
  }
  return payload.records[0];
}

function evidenceMatches(record, entry) {
  return Boolean(
    record
    && record.is_current === true
    && record.pdf_status === "verified"
    && record.pdf_object_path === entry.locator
    && record.pdf_sha256 === entry.sha256
    && Number(record.pdf_page_count) === entry.pageCount
    && Date.parse(record.pdf_verified_at) === Date.parse(entry.verifiedAt)
    && (record.pdf_error === null || record.pdf_error === undefined),
  );
}

function exactIdSortProjection(left, right) {
  return exactIdSort(left.netsuiteInternalId, right.netsuiteInternalId);
}

function evidenceProjection(entry) {
  return {
    netsuiteInternalId: entry.netsuiteInternalId,
    locator: entry.locator,
    sha256: entry.sha256,
    pageCount: entry.pageCount,
    verifiedAt: entry.verifiedAt,
  };
}

async function readAllCurrentCoordinationRecords(api, corpus) {
  const records = [];
  let expectedTotal = null;
  let offset = 0;
  while (expectedTotal === null || offset < expectedTotal) {
    const query = new URLSearchParams({
      run: corpus.runSlug,
      view: "records",
      current: "true",
      limit: "500",
      offset: String(offset),
    });
    const page = await api.get(`${coordinationPath}?${query}`);
    if (!Array.isArray(page?.records) || !Number.isInteger(page?.total)) {
      throw new Error("Full evidence readback returned an invalid page");
    }
    if (expectedTotal === null) expectedTotal = page.total;
    if (page.total !== expectedTotal) throw new Error("Full evidence aggregate changed during readback");
    if (!page.records.length && offset < expectedTotal) throw new Error("Full evidence readback ended early");
    records.push(...page.records);
    offset += page.records.length;
  }
  if (records.length !== corpus.expectedCount || records.length !== expectedTotal) {
    throw new Error(`Full evidence readback has ${records.length} current records; expected ${corpus.expectedCount}`);
  }
  const byId = new Map();
  for (const record of records) {
    const internalId = String(record?.netsuite_internal_id ?? "");
    if (!internalIdPattern.test(internalId) || byId.has(internalId)) {
      throw new Error(`Full evidence readback has an invalid or duplicate exact ID ${internalId || "(blank)"}`);
    }
    byId.set(internalId, record);
  }
  const expectedIds = corpus.entries.map((entry) => entry.netsuiteInternalId).sort(exactIdSort);
  const actualIds = [...byId.keys()].sort(exactIdSort);
  if (canonicalJsonBytes(expectedIds) !== canonicalJsonBytes(actualIds)) {
    throw new Error("Full evidence readback current-ID set differs from the local corpus");
  }
  return { records, byId };
}

export async function verifyEvidenceResumePrefix(api, corpus, confirmedPrefix) {
  if (!Number.isInteger(confirmedPrefix) || confirmedPrefix < 1 || confirmedPrefix > corpus.entries.length) {
    throw new Error("Resume prefix is outside the exact evidence worklist");
  }
  const { byId } = await readAllCurrentCoordinationRecords(api, corpus);
  const projection = [];
  for (const entry of corpus.entries.slice(0, confirmedPrefix)) {
    const record = byId.get(entry.netsuiteInternalId);
    if (!evidenceMatches(record, entry)) {
      throw new Error(`Resume prefix live evidence drifted at exact ID ${entry.netsuiteInternalId}`);
    }
    projection.push(evidenceProjection(entry));
  }
  return {
    records: projection.length,
    evidenceSha256: sha256Text(canonicalJsonBytes(projection)),
  };
}

export async function verifyEvidenceAggregate(api, corpus) {
  const { records } = await readAllCurrentCoordinationRecords(api, corpus);
  const projection = records.map((record) => {
    const internalId = String(record?.netsuite_internal_id ?? "");
    const verifiedAtMilliseconds = Date.parse(record?.pdf_verified_at);
    if (
      !internalIdPattern.test(internalId)
      || record?.is_current !== true
      || record?.pdf_status !== "verified"
      || typeof record?.pdf_object_path !== "string"
      || !sha256Pattern.test(String(record?.pdf_sha256 ?? ""))
      || !Number.isInteger(Number(record?.pdf_page_count))
      || Number(record?.pdf_page_count) < 1
      || !Number.isFinite(verifiedAtMilliseconds)
      || !(record?.pdf_error === null || record?.pdf_error === undefined)
    ) {
      throw new Error(`Full evidence readback is incomplete for exact ID ${internalId || "(blank)"}`);
    }
    return {
      netsuiteInternalId: internalId,
      locator: record.pdf_object_path,
      sha256: record.pdf_sha256,
      pageCount: Number(record.pdf_page_count),
      verifiedAt: new Date(verifiedAtMilliseconds).toISOString(),
    };
  }).sort(exactIdSortProjection);
  if (new Set(projection.map((entry) => entry.netsuiteInternalId)).size !== projection.length) {
    throw new Error("Full evidence readback repeats an exact Internal ID");
  }
  const expectedProjection = corpus.entries.map(evidenceProjection).sort(exactIdSortProjection);
  const actualHash = sha256Text(canonicalJsonBytes(projection));
  const expectedHash = sha256Text(canonicalJsonBytes(expectedProjection));
  if (actualHash !== expectedHash) {
    const expectedById = new Map(expectedProjection.map((entry) => [entry.netsuiteInternalId, entry]));
    const firstMismatch = projection.find((entry) => (
      canonicalJsonBytes(entry) !== canonicalJsonBytes(expectedById.get(entry.netsuiteInternalId))
    ));
    throw new Error(`Full evidence readback differs from the local corpus${firstMismatch ? ` at exact ID ${firstMismatch.netsuiteInternalId}` : ""}`);
  }
  return {
    records: projection.length,
    evidenceSha256: actualHash,
  };
}

function initialState(corpus, actorKey) {
  return {
    schema: LOCAL_EVIDENCE_SCHEMA,
    version: LOCAL_EVIDENCE_VERSION,
    runSlug: corpus.runSlug,
    corpusSha256: corpus.corpusSha256,
    exactIdsSha256: corpus.exactIdsSha256,
    membershipFileSha256: corpus.membershipFileSha256,
    inventoryFileSha256: corpus.inventoryFileSha256,
    expectedCount: corpus.expectedCount,
    actorKey,
    status: "registering",
    confirmedPrefix: 0,
    lastConfirmed: null,
    updatedAt: new Date().toISOString(),
  };
}

function validatePriorState(state, corpus) {
  if (!state) return;
  if (
    state.schema !== LOCAL_EVIDENCE_SCHEMA
    || state.version !== LOCAL_EVIDENCE_VERSION
    || state.runSlug !== corpus.runSlug
    || state.corpusSha256 !== corpus.corpusSha256
    || state.exactIdsSha256 !== corpus.exactIdsSha256
    || state.membershipFileSha256 !== corpus.membershipFileSha256
    || state.inventoryFileSha256 !== corpus.inventoryFileSha256
    || state.expectedCount !== corpus.expectedCount
    || !Number.isInteger(state.confirmedPrefix)
    || state.confirmedPrefix < 0
    || state.confirmedPrefix > corpus.entries.length
  ) {
    throw new Error("Existing evidence state belongs to a different or invalid exact corpus; use a new explicit state path");
  }
  if (state.confirmedPrefix > 0) {
    const priorEntry = corpus.entries[state.confirmedPrefix - 1];
    if (
      state.lastConfirmed?.netsuiteInternalId !== priorEntry.netsuiteInternalId
      || state.lastConfirmed?.sha256 !== priorEntry.sha256
      || state.lastConfirmed?.locator !== priorEntry.locator
    ) {
      throw new Error("Existing evidence state has an invalid confirmed-prefix fence");
    }
  }
}

export async function applyEvidenceCorpus({ api, corpus, statePath, actorKey = "codex", onProgress = (_progress) => {} }) {
  const resolvedStatePath = path.resolve(requireText(statePath, "--state"));
  const previousState = await readOptionalJson(resolvedStatePath);
  validatePriorState(previousState, corpus);
  const state = previousState ?? initialState(corpus, actorKey);
  state.actorKey = actorKey;
  state.status = "registering";
  state.updatedAt = new Date().toISOString();
  await atomicWriteJson(resolvedStatePath, state);
  let registeredThisRun = 0;
  let alreadyExactThisRun = 0;

  try {
    if (state.confirmedPrefix > 0) {
      const resumeReadback = await verifyEvidenceResumePrefix(api, corpus, state.confirmedPrefix);
      state.resumePrefixReadbackSha256 = resumeReadback.evidenceSha256;
      state.resumePrefixReadbackRecords = resumeReadback.records;
      state.updatedAt = new Date().toISOString();
      await atomicWriteJson(resolvedStatePath, state);
    }
    for (let index = state.confirmedPrefix; index < corpus.entries.length; index += 1) {
      const entry = corpus.entries[index];
      let readback = await readExactCoordinationRecord(api, corpus.runSlug, entry.netsuiteInternalId);
      let outcome = "already_exact";
      if (!evidenceMatches(readback, entry)) {
        await api.post({
          action: "pdf",
          runSlug: corpus.runSlug,
          actorKey,
          netsuiteInternalId: entry.netsuiteInternalId,
          status: "verified",
          objectPath: entry.locator,
          sha256: entry.sha256,
          pageCount: entry.pageCount,
          verifiedAt: entry.verifiedAt,
        });
        readback = await readExactCoordinationRecord(api, corpus.runSlug, entry.netsuiteInternalId);
        outcome = "registered";
        registeredThisRun += 1;
      } else {
        alreadyExactThisRun += 1;
      }
      if (!evidenceMatches(readback, entry)) {
        throw new Error(`Evidence ${entry.netsuiteInternalId} failed exact coordination readback`);
      }
      state.confirmedPrefix = index + 1;
      state.lastConfirmed = {
        ordinal: index + 1,
        netsuiteInternalId: entry.netsuiteInternalId,
        locator: entry.locator,
        sha256: entry.sha256,
        pageCount: entry.pageCount,
        verifiedAt: entry.verifiedAt,
        outcome,
        confirmedAt: new Date().toISOString(),
      };
      state.updatedAt = new Date().toISOString();
      await atomicWriteJson(resolvedStatePath, state);
      onProgress({
        phase: "register",
        completed: index + 1,
        total: corpus.entries.length,
        internalId: entry.netsuiteInternalId,
        outcome,
      });
    }

    // A prefix checkpoint is only a resume hint. Completion always rereads every
    // current coordination row and proves the full locator/hash/page/time set.
    const aggregate = await verifyEvidenceAggregate(api, corpus);
    const status = await api.get(`${coordinationPath}?${new URLSearchParams({ run: corpus.runSlug, events: "0" })}`);
    if (
      Number(status?.counts?.current) !== corpus.expectedCount
      || Number(status?.counts?.pdf_verified) !== corpus.expectedCount
    ) {
      throw new Error("Final coordination aggregate does not show every exact current ID with verified evidence");
    }
    state.status = "complete";
    state.updatedAt = new Date().toISOString();
    state.completedAt = state.updatedAt;
    state.finalCounts = {
      current: Number(status.counts.current),
      pdfVerified: Number(status.counts.pdf_verified),
    };
    state.evidenceReadbackSha256 = aggregate.evidenceSha256;
    state.evidenceReadbackRecords = aggregate.records;
    state.blocker = null;
    await atomicWriteJson(resolvedStatePath, state);
    return {
      statePath: resolvedStatePath,
      confirmedTotal: state.confirmedPrefix,
      registeredThisRun,
      alreadyExactThisRun,
      finalCounts: state.finalCounts,
      evidenceReadbackSha256: aggregate.evidenceSha256,
      evidenceReadbackRecords: aggregate.records,
    };
  } catch (error) {
    state.status = "blocked";
    state.updatedAt = new Date().toISOString();
    state.blocker = {
      at: state.updatedAt,
      afterConfirmedPrefix: state.confirmedPrefix,
      nextInternalId: corpus.entries[state.confirmedPrefix]?.netsuiteInternalId ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
    await atomicWriteJson(resolvedStatePath, state);
    throw error;
  }
}

function publicCorpusSummary(corpus, mode) {
  return {
    schema: `${LOCAL_EVIDENCE_SCHEMA}-receipt`,
    version: LOCAL_EVIDENCE_VERSION,
    mode,
    runSlug: corpus.runSlug,
    exactEntriesValidated: corpus.entries.length,
    expectedCount: corpus.expectedCount,
    membershipFileSha256: corpus.membershipFileSha256,
    inventoryFileSha256: corpus.inventoryFileSha256,
    exactIdsSha256: corpus.exactIdsSha256,
    corpusSha256: corpus.corpusSha256,
    totalPdfPages: corpus.totalPdfPages,
    totalPdfBytes: corpus.totalPdfBytes,
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseEvidenceArgs(process.argv.slice(2));
  const receiptPath = path.resolve(requireText(args.receipt, "--receipt"));
  const apply = Boolean(args.apply);
  let receipt = {
    schema: `${LOCAL_EVIDENCE_SCHEMA}-receipt`,
    version: LOCAL_EVIDENCE_VERSION,
    mode: apply ? "apply" : "dry-run",
    startedAt,
    completedAt: null,
    stopReason: "validation_failed",
    result: null,
    error: null,
  };
  try {
    const corpus = await validateEvidenceCorpus({
      membershipPath: requireText(args.membership, "--membership"),
      inventoryPath: requireText(args.inventory, "--inventory"),
      evidenceRoot: requireText(args["evidence-root"], "--evidence-root"),
      pythonPath: args.python ?? process.env.TAM_PDF_PYTHON,
      onProgress(progress) {
        if (progress.completed === 1 || progress.completed % 100 === 0 || progress.completed === progress.total) {
          console.log(`validate ${progress.completed}/${progress.total}`);
        }
      },
    });
    receipt = {
      ...receipt,
      ...publicCorpusSummary(corpus, apply ? "apply" : "dry-run"),
      stopReason: apply ? "external_blocker" : "worklist_exhausted",
    };
    if (!apply) {
      receipt.completedAt = new Date().toISOString();
      receipt.result = { externalActionsAttempted: 0, externalActionsConfirmed: 0 };
      await atomicWriteJson(receiptPath, receipt);
      console.log(JSON.stringify({ ok: true, receiptPath, ...publicCorpusSummary(corpus, "dry-run") }, null, 2));
      return;
    }
    if (args.confirm !== LOCAL_EVIDENCE_APPLY_CONFIRMATION) {
      throw new Error(`Apply mode requires --confirm ${LOCAL_EVIDENCE_APPLY_CONFIRMATION}`);
    }
    const statePath = path.resolve(requireText(args.state, "--state"));
    const actorKey = requireText(args.actor ?? process.env.TAM_ACTOR_KEY ?? "codex", "--actor");
    const api = createCoordinationApi({
      baseUrl: args["base-url"] ?? process.env.TAM_COORDINATION_BASE_URL ?? process.env.APP_BASE_URL,
      agentToken: process.env.AGENT_TOKEN,
      authMode: args["auth-mode"] ?? "agent-header",
    });
    const result = await applyEvidenceCorpus({
      api,
      corpus,
      statePath,
      actorKey,
      onProgress(progress) {
        console.log(`${progress.outcome} ${progress.completed}/${progress.total} NetSuite ID ${progress.internalId}`);
      },
    });
    receipt.completedAt = new Date().toISOString();
    receipt.stopReason = "worklist_exhausted";
    receipt.result = result;
    await atomicWriteJson(receiptPath, receipt);
    console.log(JSON.stringify({ ok: true, receiptPath, result }, null, 2));
  } catch (error) {
    receipt.completedAt = new Date().toISOString();
    receipt.error = error instanceof Error ? error.message : String(error);
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
