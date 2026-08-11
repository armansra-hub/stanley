#!/usr/bin/env node

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";
import {
  canonicalJsonBytes,
  createCoordinationApi,
  sha256Text,
} from "./tam-coordination-sync.mjs";

export const CHECKPOINT_SEED_SCHEMA = "tam-checkpoint-seed";
export const CHECKPOINT_SEED_VERSION = 1;
export const CHECKPOINT_SEED_APPLY_CONFIRMATION = "APPLY_EXACT_TAM_CHECKPOINT_SEED_6949";
export const DEFAULT_RUN_SLUG = "ars-bs-tam-current";

export const PRODUCTION_CHECKPOINT = Object.freeze({
  currentTotal: 6_949,
  removedTotal: 34,
  pdfVerified: 6_949,
  publishedComplete: 2_696,
  legacySchemaRecovery: 2_240,
  lostStagingRecovery: 3,
  activeHold: 49,
  unrepresented: 1_961,
  currentSnapshotSha256: "1a539c7e3ffe8af9b44aa4e7d120449e6e7aed9f6932137caa7268da6993156e",
  allowedPriorSnapshotSha256: ["e44d06e4d4b0a8146dbeb58eb99c0baf7ba1c93df402cb786429145b85246ca2"],
  reconciliationManifestSha256: "5e3072347fd25ed56f2916b2f4485d0183a4ccf96e5b09bcdc02e1182d63e6ce",
  finalAssessmentsSha256: "50586b401e3c455260bb90436b6bbcf43d049e8272750c14d83c1dd39344c0c1",
  publishQueueSha256: "d0134db0a745f024bccfaffdf3762eaac8e6bf1ed927f98956139cd3f47a75eb",
  currentPdfInventorySha256: "25acada430c358dd43d324c362bda3f25986b7d8b95f45fd109671b5e918cd8c",
  currentMembershipSha256: "61708344dd9527141401c1b61dd36cc08c185d0efd418426f982364ed118bbfa",
  coordinationMembershipSha256: "c907b130f6c064beca576520eaca82c325868c9df8fa039053b12ecda218d414",
  removedMembershipSha256: "a95259f8634c8d1f63e9126dc3413ce94f59f051df42f95ffd0ac9d468a24eeb",
  gradingManifestSha256: "c0f3e809a4b06c48750e2783e6f386580a1026535ff948ee9eef31f904c000cf",
  liveFinalReconciliationSha256: "df22e1336e885a4918ddff13c530acd8afaa262b55325f15c12af611e46924c3",
  cohortHashes: Object.freeze({
    current: "2294caa9c38d2302437a8fda18c54316c3416695d21871fd4b3ea9c6e58c7de9",
    removed: "a9893713cabdcc6f053004a3fb0530aa84e6d9419fa6293496ded73f1ed19881",
    publishedComplete: "6e30f7747f5e3201954bb9fc82160484f97d19ad8a5af2590401be1c40a64d1d",
    legacySchemaRecovery: "57898de64e0f2d1d9dac20ccec39f66a2d804a7c2434f53648b0d58961bb4571",
    lostStagingRecovery: "1b3e140b16b9eab67747c285bd620e43d453a055cccbfb95b039afb2f425d840",
    activeHold: "ca8778eb3f0416f9152186de207adeae779a09c79813e2ce83218fc14a7cda29",
    unrepresented: "08383fc5bed27d2691df5186ae481e13ff1bec986c4ba2793c163b2f89f7daa7",
  }),
  lostReceiptHashes: Object.freeze({
    "192808358": "20e1b86c7d1ae3d4bc5188134241c07afb9b2c9dcd1b680ddc8991e8b7164ee2",
    "192911789": "ed01869fc3d27feaf1c7daa1a8b0d27ad24cd48d8dda5e67fa7abdb2e1380af0",
    "192919485": "9844373f4699f84625c8a9e9d1be2fab50bc72b544c8ebf5c0a8dd94f4318782",
  }),
});

const coordinationPath = "/api/cron/tam-coordination";
const sha256Pattern = /^[0-9a-f]{64}$/;
const internalIdPattern = /^[0-9]+$/;
const completeFields = [
  "old_gold_score",
  "old_gold_class",
  "intro_call_exists",
  "opportunity_exists",
];

function isCurrentSchemaAssessment(value) {
  return completeFields.every((field) => Object.hasOwn(value ?? {}, field))
    && typeof value.old_gold_score === "number"
    && Number.isFinite(value.old_gold_score)
    && typeof value.old_gold_class === "string"
    && value.old_gold_class.trim().length > 0
    && typeof value.intro_call_exists === "boolean"
    && typeof value.opportunity_exists === "boolean";
}

function validateCurrentSchemaAssessment(value, internalId) {
  if (!isCurrentSchemaAssessment(value)) {
    throw new Error(`Complete final ${internalId} lacks current Old Gold/boolean fields`);
  }
  if (
    String(value.exact_id ?? "") !== internalId
    || typeof value.final_score !== "number"
    || !Number.isFinite(value.final_score)
    || value.final_score < 0
    || value.final_score > 100
    || typeof value.record_digest !== "string"
    || !value.record_digest.trim()
    || value.old_gold_score < 0
    || value.old_gold_score > 100
    || !Array.isArray(value.old_gold_reasons)
    || value.old_gold_reasons.some((reason) => typeof reason !== "string")
    || (![null, ""].includes(value.revisit_on) && !/^\d{4}-\d{2}-\d{2}$/.test(String(value.revisit_on ?? "")))
    || typeof value.dq_reason !== "string"
    || typeof value.score_adjust_note !== "string"
    || value.validation?.status !== "passed"
    || !String(value.validation?.validated_by ?? "").trim()
  ) throw new Error(`Complete final ${internalId} violates the current assessment schema`);
  normalizeTimestamp(value.validation.validated_at, `Complete final ${internalId} validation time`);
  if (value.final_score <= 10 && (
    value.old_gold_score !== 0
    || value.old_gold_class !== "dead"
    || !value.dq_reason.trim()
  )) throw new Error(`Complete final ${internalId} has inconsistent dead-band evidence`);
  if (value.final_score > 10 && value.old_gold_class === "dead") {
    throw new Error(`Complete final ${internalId} uses dead Old Gold class above the dead band`);
  }
}

function requireText(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required`);
  return text;
}

function requireSha256(value, label) {
  const text = requireText(value, label);
  if (!sha256Pattern.test(text)) throw new Error(`${label} must be a lowercase SHA-256`);
  return text;
}

function requireExactId(value, label) {
  const text = requireText(value, label);
  if (!internalIdPattern.test(text)) throw new Error(`${label} must be an exact numeric Internal ID`);
  return text;
}

function exactIdSort(left, right) {
  const lengthDelta = left.length - right.length;
  return lengthDelta || left.localeCompare(right);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

/**
 * Reproduce Python json.dumps(value, ensure_ascii=True, sort_keys=True,
 * separators=(",", ":")) byte-for-byte. Historical provenance receipts were
 * generated by Python and deliberately have no trailing newline.
 */
export function pythonAsciiCanonicalJson(value) {
  return JSON.stringify(stableValue(value)).replace(/[\u007f-\uffff]/g, (character) => (
    `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  ));
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function orderedIdHash(ids) {
  return sha256Bytes(Buffer.from(ids.map((id) => `${id}\n`).join(""), "utf8"));
}

function pdfBindingSha256(row) {
  const verifiedAt = normalizeTimestamp(row.pdfVerifiedAt, `PDF ${row.netsuiteInternalId} verified time`)
    .replace(/\.(\d{3})Z$/, (_match, milliseconds) => `.${milliseconds}000Z`);
  return sha256Bytes(Buffer.from(
    `${row.netsuiteInternalId}\t${row.pdfObjectPath}\t${row.pdfSha256}\t${row.pdfPageCount}\t${verifiedAt}\n`,
    "utf8",
  ));
}

function normalizeTimestamp(value, label) {
  const text = requireText(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) throw new Error(`${label} must be an ISO date-time`);
  return new Date(milliseconds).toISOString();
}

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

async function readArtifact(filePath, label) {
  const resolved = path.resolve(requireText(filePath, label));
  try {
    const bytes = await readFile(resolved);
    return { path: resolved, bytes, sha256: sha256Bytes(bytes) };
  } catch (error) {
    throw new Error(`${label} could not be read at ${resolved}: ${error.message}`);
  }
}

async function readJsonArtifact(filePath, label) {
  const artifact = await readArtifact(filePath, label);
  try {
    return { ...artifact, value: JSON.parse(artifact.bytes.toString("utf8")) };
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

async function readJsonlArtifact(filePath, idField, label) {
  const artifact = await readArtifact(filePath, label);
  const text = artifact.bytes.toString("utf8");
  const rawLines = text.split("\n");
  const rows = [];
  const byId = new Map();
  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index].endsWith("\r") ? rawLines[index].slice(0, -1) : rawLines[index];
    if (!raw.trim()) continue;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${label}:${index + 1} is invalid JSON: ${error.message}`);
    }
    const internalId = requireExactId(value?.[idField], `${label}:${index + 1} ${idField}`);
    if (byId.has(internalId)) throw new Error(`${label} repeats exact Internal ID ${internalId}`);
    const row = {
      value,
      internalId,
      lineNumber: index + 1,
      lineSha256: sha256Bytes(Buffer.from(raw, "utf8")),
    };
    rows.push(row);
    byId.set(internalId, row);
  }
  return { ...artifact, rows, byId };
}

async function readSheetArtifact(filePath, label) {
  const artifact = await readArtifact(filePath, label);
  let workbook;
  try {
    workbook = XLSX.read(artifact.bytes, { type: "buffer", raw: true });
  } catch (error) {
    throw new Error(`${label} is not a readable CSV/spreadsheet: ${error.message}`);
  }
  if (workbook.SheetNames.length !== 1) throw new Error(`${label} must contain exactly one sheet`);
  return {
    ...artifact,
    rows: XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
      defval: "",
      raw: false,
    }),
  };
}

function requireColumns(rows, columns, label) {
  if (!rows.length) throw new Error(`${label} is empty`);
  for (const column of columns) {
    if (!Object.hasOwn(rows[0], column)) throw new Error(`${label} is missing required column ${column}`);
  }
}

async function atomicWrite(filePath, bytes) {
  const target = path.resolve(filePath);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, target);
}

async function atomicWriteJson(filePath, value) {
  await atomicWrite(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

async function mapWithConcurrency(values, concurrency, worker) {
  let cursor = 0;
  const result = new Array(values.length);
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await worker(values[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

function assertSameIdSet(expectedIds, actualIds, label) {
  const expected = [...expectedIds].sort(exactIdSort);
  const actual = [...actualIds].sort(exactIdSort);
  if (!isDeepStrictEqual(actual, expected)) throw new Error(`${label} exact-ID set differs from current membership`);
}

function buildEvidenceRows(inventoryArtifact, expectedIds) {
  requireColumns(inventoryArtifact.rows, [
    "Internal ID",
    "Captured At UTC",
    "PDF SHA256",
    "PDF Pages",
    "PDF Bytes",
    "Capture Metadata SHA256",
    "Capture Snapshot SHA256",
  ], "Current PDF inventory");
  const byId = new Map();
  for (const [index, source] of inventoryArtifact.rows.entries()) {
    const internalId = requireExactId(source["Internal ID"], `Current PDF inventory row ${index + 1} Internal ID`);
    if (byId.has(internalId)) throw new Error(`Current PDF inventory repeats exact Internal ID ${internalId}`);
    const sha256 = requireSha256(source["PDF SHA256"], `PDF ${internalId} SHA-256`);
    const pageCount = parsePositiveInteger(source["PDF Pages"], `PDF ${internalId} pages`);
    const bytes = parsePositiveInteger(source["PDF Bytes"], `PDF ${internalId} bytes`);
    const captureSha256 = requireSha256(source["Capture Metadata SHA256"], `Capture ${internalId} SHA-256`);
    const captureSnapshotSha256 = requireSha256(
      source["Capture Snapshot SHA256"],
      `Capture ${internalId} snapshot SHA-256`,
    );
    byId.set(internalId, {
      netsuiteInternalId: internalId,
      locator: `leads/${internalId}/print.pdf`,
      sha256,
      pageCount,
      verifiedAt: normalizeTimestamp(source["Captured At UTC"], `PDF ${internalId} captured time`),
      bytes,
      captureSha256,
      captureSnapshotSha256,
    });
  }
  assertSameIdSet(expectedIds, byId.keys(), "Current PDF inventory");
  return byId;
}

function validatePdfReconciliation(reconciliation, artifacts, expectedIds, strictProduction) {
  const manifest = reconciliation.value;
  if (
    manifest?.schema !== "tam-current-pdf-reconciliation"
    || manifest?.version !== 1
    || manifest?.status !== "complete"
    || manifest?.exact_set_checks?.every_current_id_has_one_valid_package !== true
    || manifest?.exact_set_checks?.historical_inventory_exactly_equals_removed !== true
  ) throw new Error("PDF reconciliation manifest is not the completed exact-set receipt");
  if (Number(manifest?.counts?.current_membership_ids) !== expectedIds.length) {
    throw new Error("PDF reconciliation current membership count differs");
  }
  if (manifest?.outputs?.current_pdf_inventory_sha256 !== artifacts.pdfInventory.sha256) {
    throw new Error("PDF reconciliation inventory SHA-256 differs from the supplied inventory");
  }
  if (manifest?.inputs?.membership?.sha256 !== artifacts.evidenceMembership.sha256) {
    throw new Error("PDF reconciliation membership SHA-256 differs from the evidence membership file");
  }
  if (strictProduction) {
    if (reconciliation.sha256 !== PRODUCTION_CHECKPOINT.reconciliationManifestSha256) {
      throw new Error("PDF reconciliation manifest is not the audited production artifact");
    }
    if (artifacts.pdfInventory.sha256 !== PRODUCTION_CHECKPOINT.currentPdfInventorySha256) {
      throw new Error("Current PDF inventory is not the audited production artifact");
    }
    if (artifacts.evidenceMembership.sha256 !== PRODUCTION_CHECKPOINT.currentMembershipSha256) {
      throw new Error("Current membership CSV is not the audited production artifact");
    }
  }
  return {
    current: requireSha256(manifest.current_snapshot_sha256, "Current capture snapshot SHA-256"),
    allowedPrior: (manifest.allowed_prior_snapshot_sha256 ?? []).map((value, index) => (
      requireSha256(value, `Allowed prior snapshot SHA-256 ${index + 1}`)
    )),
  };
}

function validateEvidenceReceipt(receiptArtifact, expectedCount) {
  const receipt = receiptArtifact.value;
  if (
    receipt?.schema !== "tam-local-evidence-sync-receipt"
    || receipt?.version !== 1
    || receipt?.mode !== "apply"
    || receipt?.stopReason !== "worklist_exhausted"
    || receipt?.runSlug !== DEFAULT_RUN_SLUG
    || Number(receipt?.exactEntriesValidated) !== expectedCount
    || Number(receipt?.expectedCount) !== expectedCount
    || receipt?.error != null
    || !receipt?.result
    || Number(receipt.result.confirmedTotal) !== expectedCount
    || Number(receipt.result.evidenceReadbackRecords) !== expectedCount
  ) {
    throw new Error("checkpoint seed requires a successful completed APPLY local-evidence receipt");
  }
  return receipt;
}

/** Validate the durable bootstrap state/receipt and recompute its full hashes. */
export function validateCompletedEvidenceGate({
  stateArtifact,
  receiptArtifact,
  evidenceMembershipArtifact,
  pdfInventoryArtifact,
  evidenceById,
  expectedIds,
}) {
  const expectedCount = expectedIds.length;
  // Reject a dry-run/failure receipt before consulting any prefix state. A
  // confirmed prefix is only a resume hint and can never release checkpointing.
  const receipt = validateEvidenceReceipt(receiptArtifact, expectedCount);
  const state = stateArtifact.value;
  if (
    state?.schema !== "tam-local-evidence-sync"
    || state?.version !== 1
    || state?.runSlug !== DEFAULT_RUN_SLUG
    || state?.status !== "complete"
    || Number(state?.expectedCount) !== expectedCount
    || Number(state?.confirmedPrefix) !== expectedCount
    || Number(state?.finalCounts?.current) !== expectedCount
    || Number(state?.finalCounts?.pdfVerified) !== expectedCount
    || Number(state?.evidenceReadbackRecords) !== expectedCount
    || state?.blocker != null
  ) throw new Error("checkpoint seed requires a completed full local-evidence state, not a prefix checkpoint");

  const numericIds = [...expectedIds].sort(exactIdSort);
  const exactIdsSha256 = sha256Text(canonicalJsonBytes(numericIds));
  const entries = numericIds.map((internalId) => evidenceById.get(internalId));
  if (entries.some((entry) => !entry)) {
    throw new Error("local-evidence corpus is missing an exact current PDF binding");
  }
  const totalPdfPages = entries.reduce((total, entry) => total + entry.pageCount, 0);
  const totalPdfBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
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
  const evidenceReadbackSha256 = sha256Text(canonicalJsonBytes(entries.map((entry) => ({
    netsuiteInternalId: entry.netsuiteInternalId,
    locator: entry.locator,
    sha256: entry.sha256,
    pageCount: entry.pageCount,
    verifiedAt: entry.verifiedAt,
  }))));

  const agreement = {
    membershipFileSha256: evidenceMembershipArtifact.sha256,
    inventoryFileSha256: pdfInventoryArtifact.sha256,
    exactIdsSha256,
    corpusSha256,
    evidenceReadbackSha256,
  };
  for (const [key, expected] of Object.entries(agreement)) {
    if (state[key] !== expected || receipt[key] !== expected) {
      throw new Error(`local-evidence state/receipt ${key} differs from the exact checkpoint rows`);
    }
  }
  if (receipt.result.evidenceReadbackSha256 !== evidenceReadbackSha256) {
    throw new Error("local-evidence apply result readback hash differs from the full exact binding");
  }
  if (Number(receipt.totalPdfPages) !== totalPdfPages || Number(receipt.totalPdfBytes) !== totalPdfBytes) {
    throw new Error("local-evidence apply receipt PDF totals differ from the exact checkpoint corpus");
  }
  if (!receipt.result.statePath) {
    throw new Error("local-evidence apply receipt does not bind its explicit state file");
  }
  const receiptStatePath = path.resolve(receipt.result.statePath);
  if (path.relative(receiptStatePath, stateArtifact.path) !== "") {
    throw new Error("local-evidence receipt points to a different explicit state file");
  }
  return {
    ...agreement,
    stateSha256: stateArtifact.sha256,
    receiptSha256: receiptArtifact.sha256,
  };
}

function validateLiveFinalReconciliation(artifact, expectedFinals) {
  const value = artifact.value;
  if (
    value?.schema !== "tam-live-final-reconciliation"
    || value?.version !== 1
    || value?.allCanonicalFinalsLive !== true
    || Number(value?.canonicalFinals) !== expectedFinals
    || Number(value?.liveExactIds) !== expectedFinals
    || Number(value?.mismatchCountAfter) !== 0
    || !Array.isArray(value?.duplicateLiveIds)
    || value.duplicateLiveIds.length !== 0
  ) throw new Error("live-final reconciliation is not an exact zero-drift receipt for all staged finals");
}

async function loadHoldArtifacts(holdsDirectory) {
  const directory = path.resolve(requireText(holdsDirectory, "holds directory"));
  let names;
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^\d+\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => exactIdSort(left.slice(0, -5), right.slice(0, -5)));
  } catch (error) {
    throw new Error(`Active holds directory could not be read: ${error.message}`);
  }
  const holds = new Map();
  let normalHolds = 0;
  let exceptionHolds = 0;
  await mapWithConcurrency(names, 24, async (name) => {
    const internalId = name.slice(0, -5);
    const artifact = await readJsonArtifact(path.join(directory, name), `Hold ${internalId}`);
    let reason;
    if (artifact.value?.schema === "tam-validator-exception-hold") {
      if (artifact.value?.version !== 1 || String(artifact.value?.exactId ?? "") !== internalId) {
        throw new Error(`Validator-exception hold ${internalId} has invalid identity metadata`);
      }
      reason = requireText(artifact.value.reason, `Validator-exception hold ${internalId} reason`);
      exceptionHolds += 1;
    } else {
      if (artifact.value?.validation?.status !== "hold" || String(artifact.value?.exact_id ?? "") !== internalId) {
        throw new Error(`Hold ${internalId} is not a validated exact-ID hold`);
      }
      reason = requireText(artifact.value.validation.hold_reason, `Hold ${internalId} reason`);
      normalHolds += 1;
    }
    if (reason.length > 2_000) throw new Error(`Hold ${internalId} reason exceeds the checkpoint contract`);
    holds.set(internalId, {
      ...artifact,
      internalId,
      reason,
      kind: artifact.value?.schema === "tam-validator-exception-hold" ? "exception" : "normal",
    });
  });
  return { directory, holds, normalHolds, exceptionHolds };
}

async function loadReceipt(receiptsDirectory, internalId, required) {
  const receiptPath = path.join(receiptsDirectory, `${internalId}.json`);
  try {
    return await readJsonArtifact(receiptPath, `Historical publish receipt ${internalId}`);
  } catch (error) {
    if (!required && /ENOENT|no such file/i.test(error.message)) return null;
    throw error;
  }
}

function checkpointPaths(refreshRoot, evidenceStatePath, evidenceReceiptPath) {
  const root = path.resolve(refreshRoot);
  return {
    root,
    membership: path.join(root, "assembled_current_v9_final_7618", "coordination_membership.jsonl"),
    removedMembership: path.join(root, "assembled_current_v9_final_7618", "coordination_removed_ids.json"),
    evidenceMembership: path.join(root, "assembled_current_v9_final_7618", "current_membership.csv"),
    pdfInventory: path.join(root, "current_pdf_reconciliation_v9_final_7618", "current_pdf_inventory.csv"),
    pdfReconciliation: path.join(root, "current_pdf_reconciliation_v9_final_7618", "current_pdf_reconciliation_manifest.json"),
    finalAssessments: path.join(root, "grading_final", "final_assessments.jsonl"),
    publishQueue: path.join(root, "grading_final", "publish_queue.jsonl"),
    gradingManifest: path.join(root, "grading_final", "manifest.json"),
    liveReconciliation: path.join(root, "grading_final", "live_final_reconciliation_latest.json"),
    provenanceDirectory: path.join(root, "grading_final", "provenance"),
    publishedReceiptsDirectory: path.join(root, "grading_pool_v9", "published"),
    holdsDirectory: path.join(root, "grading_pool_v9", "holds"),
    evidenceState: path.resolve(evidenceStatePath),
    evidenceReceipt: path.resolve(evidenceReceiptPath),
  };
}

/**
 * Build and validate all exact seed rows. CLI calls are production-strict;
 * tests may supply a smaller explicit contract while exercising identical
 * derivation and hashing behavior.
 */
export async function buildCheckpointSeedBundle({
  paths,
  releaseCommit,
  manifestObjectPath = `${DEFAULT_RUN_SLUG}/checkpoint-seed-manifest.json`,
  strictProduction = true,
  expectedCounts = /** @type {Record<string, number> | undefined} */ (undefined),
  expectedCohortHashes = /** @type {Record<string, string> | undefined} */ (undefined),
  lostReceiptHashes = /** @type {Record<string, string> | undefined} */ (undefined),
  onProgress = (_progress) => {},
}) {
  const commit = requireText(releaseCommit, "release commit");
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("release commit must be a full lowercase Git SHA");
  const sourcePaths = paths;
  const [
    membership,
    removedMembership,
    evidenceMembership,
    pdfInventory,
    pdfReconciliation,
    finals,
    queue,
    gradingManifest,
    liveReconciliation,
  ] = await Promise.all([
    readJsonlArtifact(sourcePaths.membership, "netsuiteInternalId", "Coordination membership"),
    readJsonArtifact(sourcePaths.removedMembership, "Removed membership"),
    readSheetArtifact(sourcePaths.evidenceMembership, "Current membership CSV"),
    readSheetArtifact(sourcePaths.pdfInventory, "Current PDF inventory"),
    readJsonArtifact(sourcePaths.pdfReconciliation, "PDF reconciliation manifest"),
    readJsonlArtifact(sourcePaths.finalAssessments, "exact_id", "Final assessments"),
    readJsonlArtifact(sourcePaths.publishQueue, "netsuiteInternalId", "Publish queue"),
    readJsonArtifact(sourcePaths.gradingManifest, "Grading manifest"),
    readJsonArtifact(sourcePaths.liveReconciliation, "Live final reconciliation"),
  ]);

  const membershipIds = membership.rows.map((row) => row.internalId);
  if (!isDeepStrictEqual(membershipIds, [...membershipIds].sort(exactIdSort))) {
    throw new Error("coordination membership must be in exact numeric-ID order");
  }
  // Finals are intentionally a subset, so perform explicit subset validation
  // after rejecting any ID that is not current.
  for (const internalId of finals.byId.keys()) {
    if (!membership.byId.has(internalId)) throw new Error(`Final ${internalId} is not in current membership`);
  }
  for (const internalId of queue.byId.keys()) {
    if (!membership.byId.has(internalId)) throw new Error(`Publish queue ${internalId} is not in current membership`);
  }
  if (!isDeepStrictEqual([...finals.byId.keys()].sort(exactIdSort), [...queue.byId.keys()].sort(exactIdSort))) {
    throw new Error("Final assessment and publish queue exact-ID sets differ");
  }
  const removedIds = Array.isArray(removedMembership.value?.netsuiteInternalIds)
    ? removedMembership.value.netsuiteInternalIds.map((value, index) => (
      requireExactId(value, `Removed membership ID ${index + 1}`)
    ))
    : [];
  if (
    removedMembership.value?.runSlug !== DEFAULT_RUN_SLUG
    || new Set(removedIds).size !== removedIds.length
    || !isDeepStrictEqual(removedIds, [...removedIds].sort(exactIdSort))
    || removedIds.some((internalId) => membership.byId.has(internalId))
  ) throw new Error("Removed membership must be a sorted, unique exact-ID set disjoint from current membership");

  requireColumns(evidenceMembership.rows, ["Internal ID"], "Current membership CSV");
  const evidenceMembershipIds = evidenceMembership.rows.map((row, index) => (
    requireExactId(row["Internal ID"], `Current membership CSV row ${index + 1}`)
  ));
  if (new Set(evidenceMembershipIds).size !== evidenceMembershipIds.length) {
    throw new Error("Current membership CSV repeats an exact Internal ID");
  }
  assertSameIdSet(membershipIds, evidenceMembershipIds, "Evidence membership");
  const evidenceById = buildEvidenceRows(pdfInventory, membershipIds);
  const captureSnapshotHashes = validatePdfReconciliation(
    pdfReconciliation,
    { pdfInventory, evidenceMembership },
    membershipIds,
    strictProduction,
  );
  const allowedCaptureSnapshots = new Set([
    captureSnapshotHashes.current,
    ...captureSnapshotHashes.allowedPrior,
  ]);
  for (const [internalId, evidence] of evidenceById) {
    if (!allowedCaptureSnapshots.has(evidence.captureSnapshotSha256)) {
      throw new Error(`PDF ${internalId} capture snapshot is outside the manifest-bound whitelist`);
    }
  }

  if (strictProduction) {
    if (membership.sha256 !== PRODUCTION_CHECKPOINT.coordinationMembershipSha256) {
      throw new Error("Coordination membership is not the audited production artifact");
    }
    if (removedMembership.sha256 !== PRODUCTION_CHECKPOINT.removedMembershipSha256) {
      throw new Error("Removed membership is not the audited production artifact");
    }
    if (finals.sha256 !== PRODUCTION_CHECKPOINT.finalAssessmentsSha256) {
      throw new Error("Final assessments are not the audited production artifact");
    }
    if (queue.sha256 !== PRODUCTION_CHECKPOINT.publishQueueSha256) {
      throw new Error("Publish queue is not the audited production artifact");
    }
    if (gradingManifest.sha256 !== PRODUCTION_CHECKPOINT.gradingManifestSha256) {
      throw new Error("Grading manifest is not the audited production artifact");
    }
    if (liveReconciliation.sha256 !== PRODUCTION_CHECKPOINT.liveFinalReconciliationSha256) {
      throw new Error("Live final reconciliation is not the audited production artifact");
    }
  }
  if (
    gradingManifest.value?.assessment_sha256 !== finals.sha256
    || gradingManifest.value?.queue_sha256 !== queue.sha256
    || Number(gradingManifest.value?.staged_final_count) !== finals.rows.length
  ) throw new Error("Grading manifest does not bind the supplied final/queue artifacts");
  if (gradingManifest.value?.production_reconciliation_sha256 !== liveReconciliation.sha256) {
    throw new Error("Grading manifest does not bind the supplied live reconciliation receipt");
  }
  validateLiveFinalReconciliation(liveReconciliation, finals.rows.length);

  const holdArtifacts = await loadHoldArtifacts(sourcePaths.holdsDirectory);
  const holds = new Map();
  let normalHolds = 0;
  let exceptionHolds = 0;
  let supersededHolds = 0;
  for (const [internalId, hold] of holdArtifacts.holds) {
    if (!membership.byId.has(internalId)) throw new Error(`Active hold ${internalId} is not current`);
    if (finals.byId.has(internalId)) {
      supersededHolds += 1;
      continue;
    }
    holds.set(internalId, hold);
    if (hold.kind === "exception") exceptionHolds += 1;
    else normalHolds += 1;
  }

  const lostHashes = lostReceiptHashes ?? PRODUCTION_CHECKPOINT.lostReceiptHashes;
  const lostIds = Object.keys(lostHashes).sort(exactIdSort);
  for (const internalId of lostIds) {
    requireExactId(internalId, "Lost-staging Internal ID");
    requireSha256(lostHashes[internalId], `Lost-staging ${internalId} receipt SHA-256`);
    if (!membership.byId.has(internalId)) throw new Error(`Lost-staging ${internalId} is not current`);
    if (finals.byId.has(internalId) || holds.has(internalId)) {
      throw new Error(`Lost-staging ${internalId} overlaps a final or hold`);
    }
  }

  const completeIds = [];
  const legacyIds = [];
  for (const { internalId, value } of finals.rows) {
    if (isCurrentSchemaAssessment(value)) completeIds.push(internalId);
    else legacyIds.push(internalId);
  }
  const completeSet = new Set(completeIds);
  const legacySet = new Set(legacyIds);
  const lostSet = new Set(lostIds);
  const holdSet = new Set(holds.keys());
  const unrepresentedIds = membershipIds.filter((internalId) => (
    !completeSet.has(internalId)
    && !legacySet.has(internalId)
    && !lostSet.has(internalId)
    && !holdSet.has(internalId)
  ));
  const unrepresentedSet = new Set(unrepresentedIds);

  const derivedCounts = {
    currentTotal: membershipIds.length,
    removedTotal: removedIds.length,
    pdfVerified: evidenceById.size,
    publishedComplete: completeIds.length,
    legacySchemaRecovery: legacyIds.length,
    lostStagingRecovery: lostIds.length,
    activeHold: holds.size,
    unrepresented: unrepresentedIds.length,
  };
  const expected = expectedCounts ?? (strictProduction ? {
    currentTotal: PRODUCTION_CHECKPOINT.currentTotal,
    removedTotal: PRODUCTION_CHECKPOINT.removedTotal,
    pdfVerified: PRODUCTION_CHECKPOINT.pdfVerified,
    publishedComplete: PRODUCTION_CHECKPOINT.publishedComplete,
    legacySchemaRecovery: PRODUCTION_CHECKPOINT.legacySchemaRecovery,
    lostStagingRecovery: PRODUCTION_CHECKPOINT.lostStagingRecovery,
    activeHold: PRODUCTION_CHECKPOINT.activeHold,
    unrepresented: PRODUCTION_CHECKPOINT.unrepresented,
  } : derivedCounts);
  if (!isDeepStrictEqual(derivedCounts, expected)) {
    throw new Error(`checkpoint cohort counts drifted: ${JSON.stringify({ expected, derivedCounts })}`);
  }
  if (strictProduction && (normalHolds !== 45 || exceptionHolds !== 4)) {
    throw new Error("active holds must be exactly 45 validated holds plus four validator-exception holds");
  }

  const cohortById = new Map();
  for (const internalId of completeIds) cohortById.set(internalId, "published_complete");
  for (const internalId of legacyIds) cohortById.set(internalId, "legacy_schema_recovery");
  for (const internalId of lostIds) cohortById.set(internalId, "lost_staging_recovery");
  for (const internalId of holds.keys()) cohortById.set(internalId, "active_hold");
  for (const internalId of unrepresentedIds) cohortById.set(internalId, "unrepresented");
  if (cohortById.size !== membershipIds.length) throw new Error("checkpoint cohorts are not a full disjoint cover");

  const cohortHashes = {
    current: orderedIdHash(membershipIds),
    removed: orderedIdHash(removedIds),
    publishedComplete: orderedIdHash(membershipIds.filter((id) => completeSet.has(id))),
    legacySchemaRecovery: orderedIdHash(membershipIds.filter((id) => legacySet.has(id))),
    lostStagingRecovery: orderedIdHash(membershipIds.filter((id) => lostSet.has(id))),
    activeHold: orderedIdHash(membershipIds.filter((id) => holdSet.has(id))),
    unrepresented: orderedIdHash(membershipIds.filter((id) => unrepresentedSet.has(id))),
  };
  const expectedHashes = expectedCohortHashes ?? (strictProduction ? PRODUCTION_CHECKPOINT.cohortHashes : cohortHashes);
  if (!isDeepStrictEqual(cohortHashes, expectedHashes)) {
    throw new Error(`checkpoint ordered-ID hashes drifted: ${JSON.stringify({ expectedHashes, cohortHashes })}`);
  }
  if (strictProduction && (
    captureSnapshotHashes.current !== PRODUCTION_CHECKPOINT.currentSnapshotSha256
    || !isDeepStrictEqual(captureSnapshotHashes.allowedPrior, PRODUCTION_CHECKPOINT.allowedPriorSnapshotSha256)
  )) throw new Error("checkpoint capture snapshot whitelist drifted");

  onProgress({ phase: "cohorts", counts: derivedCounts, cohortHashes });

  const receiptsDirectory = path.resolve(sourcePaths.publishedReceiptsDirectory);
  const provenanceDirectory = path.resolve(sourcePaths.provenanceDirectory);
  const receiptById = new Map();
  await mapWithConcurrency(finals.rows, 24, async ({ internalId }) => {
    const artifact = await loadReceipt(receiptsDirectory, internalId, completeSet.has(internalId));
    if (artifact) receiptById.set(internalId, artifact);
  });
  for (const internalId of lostIds) {
    const artifact = await loadReceipt(receiptsDirectory, internalId, true);
    if (artifact.sha256 !== lostHashes[internalId]) {
      throw new Error(`Lost-staging ${internalId} historical receipt SHA-256 drifted`);
    }
    receiptById.set(internalId, artifact);
  }

  const preparedComplete = new Map();
  let verifiedProvenance = 0;
  await mapWithConcurrency(completeIds, 24, async (internalId) => {
    const finalLine = finals.byId.get(internalId);
    const queueLine = queue.byId.get(internalId);
    const assessment = finalLine.value;
    validateCurrentSchemaAssessment(assessment, internalId);
    const queueRow = queueLine.value;
    const provenanceData = queueRow?.provenance?.data;
    const provenanceSha256 = requireSha256(queueRow?.provenance?.sha256, `Provenance ${internalId} SHA-256`);
    const canonicalJson = pythonAsciiCanonicalJson(provenanceData);
    if (canonicalJson.endsWith("\n")) throw new Error(`Provenance ${internalId} canonical JSON has a trailing newline`);
    if (sha256Bytes(Buffer.from(canonicalJson, "utf8")) !== provenanceSha256) {
      throw new Error(`Provenance ${internalId} does not reproduce Python ensure_ascii canonical bytes`);
    }
    const provenanceArtifact = await readArtifact(
      path.join(provenanceDirectory, `${internalId}.json`),
      `Provenance receipt ${internalId}`,
    );
    if (provenanceArtifact.sha256 !== provenanceSha256 || provenanceArtifact.bytes.toString("utf8") !== canonicalJson) {
      throw new Error(`Provenance receipt ${internalId} differs from reconstructed canonical bytes`);
    }
    if (!isDeepStrictEqual(provenanceData?.assessment, assessment)) {
      throw new Error(`Provenance ${internalId} assessment differs from the final assessment line`);
    }
    if (
      queueRow?.finalScore !== assessment.final_score
      || queueRow?.recordDigest !== assessment.record_digest
      || queueRow?.validation?.status !== "passed"
      || queueRow?.validation?.validatedBy !== assessment.validation?.validated_by
      || queueRow?.validation?.validatedAt !== assessment.validation?.validated_at
      || provenanceData?.runSlug !== DEFAULT_RUN_SLUG
      || String(provenanceData?.netsuiteInternalId ?? "") !== internalId
      || provenanceData?.method !== "full-record-reader-plus-independent-full-record-validator"
      || provenanceData?.validatorHashScope !== "canonical-record"
      || provenanceData?.snapshotSha256 !== captureSnapshotHashes.current
    ) throw new Error(`Complete final ${internalId} violates the full two-pass provenance contract`);
    const evidence = evidenceById.get(internalId);
    if (provenanceData?.pdfSha256 !== evidence.sha256 || Number(provenanceData?.pdfPageCount) !== evidence.pageCount) {
      throw new Error(`Complete final ${internalId} provenance differs from exact PDF evidence`);
    }
    const historicalReceipt = receiptById.get(internalId);
    // A later validated revision can supersede the payload captured by an
    // older per-ID receipt. Bind that receipt as historical provenance, but use
    // the canonical queue plus the fresh full live reconciliation/readback as
    // the final-value authority.
    if (String(historicalReceipt.value?.record?.exact_id ?? "") !== internalId) {
      throw new Error(`Historical publish receipt ${internalId} has a different exact Internal ID`);
    }
    const historicalPublishedAt = requireText(
      historicalReceipt.value?.publishedAt,
      `Historical publish receipt ${internalId} publishedAt`,
    );
    normalizeTimestamp(historicalPublishedAt, `Historical publish receipt ${internalId} publishedAt`);
    preparedComplete.set(internalId, {
      finalAssessmentLineSha256: finalLine.lineSha256,
      publishQueueLineSha256: queueLine.lineSha256,
      historicalReceiptSha256: historicalReceipt.sha256,
      historicalPublishedAt,
      finalScore: queueRow.finalScore,
      recordDigest: queueRow.recordDigest,
      ...(queueRow.scoreAdjustNote === undefined ? {} : { scoreAdjustNote: queueRow.scoreAdjustNote }),
      provenance: {
        sha256: provenanceSha256,
        objectPath: requireText(queueRow.provenance.objectPath, `Provenance ${internalId} object path`),
        canonicalJson,
        data: provenanceData,
      },
      validation: queueRow.validation,
    });
    verifiedProvenance += 1;
  });
  if (verifiedProvenance !== completeIds.length) throw new Error("not every complete provenance receipt was verified");
  onProgress({ phase: "provenance", verified: verifiedProvenance });

  const rows = membershipIds.map((internalId, index) => {
    const evidence = evidenceById.get(internalId);
    const recoveryCohort = cohortById.get(internalId);
    const base = {
      recoveryCohort,
      netsuiteInternalId: internalId,
      membershipOrdinal: index + 1,
      tableRowsSha256: requireSha256(
        membership.byId.get(internalId).value?.tableRowsSha256,
        `Membership ${internalId} table-rows SHA-256`,
      ),
      pdfObjectPath: evidence.locator,
      pdfSha256: evidence.sha256,
      pdfPageCount: evidence.pageCount,
      pdfVerifiedAt: evidence.verifiedAt,
      pdfCaptureSnapshotSha256: evidence.captureSnapshotSha256,
    };
    if (recoveryCohort === "published_complete") return { ...base, ...preparedComplete.get(internalId) };
    if (recoveryCohort === "legacy_schema_recovery") {
      const finalLine = finals.byId.get(internalId);
      const queueLine = queue.byId.get(internalId);
      const receipt = receiptById.get(internalId);
      return {
        ...base,
        finalAssessmentLineSha256: finalLine.lineSha256,
        publishQueueLineSha256: queueLine.lineSha256,
        ...(receipt ? { historicalReceiptSha256: receipt.sha256 } : {}),
      };
    }
    if (recoveryCohort === "lost_staging_recovery") {
      return { ...base, historicalReceiptSha256: lostHashes[internalId] };
    }
    if (recoveryCohort === "active_hold") {
      const hold = holds.get(internalId);
      return { ...base, holdFileSha256: hold.sha256, holdReason: hold.reason };
    }
    return base;
  });
  const rowsBytes = Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  const rowsSha256 = sha256Bytes(rowsBytes);

  // Validate the apply state only after all local artifacts/provenance have
  // been audited. A failed evidence receipt still prevents any seed RPC.
  const [evidenceState, evidenceReceipt] = await Promise.all([
    readJsonArtifact(sourcePaths.evidenceState, "Local evidence state"),
    readJsonArtifact(sourcePaths.evidenceReceipt, "Local evidence apply receipt"),
  ]);
  const evidenceGate = validateCompletedEvidenceGate({
    stateArtifact: evidenceState,
    receiptArtifact: evidenceReceipt,
    evidenceMembershipArtifact: evidenceMembership,
    pdfInventoryArtifact: pdfInventory,
    evidenceById,
    expectedIds: membershipIds,
  });

  const sourceHashes = {
    pdf_reconciliation_manifest_sha256: pdfReconciliation.sha256,
    coordination_membership_sha256: membership.sha256,
    coordination_removed_ids_sha256: removedMembership.sha256,
    current_membership_sha256: evidenceMembership.sha256,
    current_pdf_inventory_sha256: pdfInventory.sha256,
    final_assessments_sha256: finals.sha256,
    publish_queue_sha256: queue.sha256,
    grading_manifest_sha256: gradingManifest.sha256,
    live_final_reconciliation_sha256: liveReconciliation.sha256,
    localEvidenceState: evidenceGate.stateSha256,
    localEvidenceReceipt: evidenceGate.receiptSha256,
    evidence_corpus_sha256: evidenceGate.corpusSha256,
    evidence_readback_sha256: evidenceGate.evidenceReadbackSha256,
    checkpoint_rows_sha256: rowsSha256,
  };
  const normalizedManifestObjectPath = requireText(manifestObjectPath, "manifest object path");
  const manifest = stableValue({
    schema: CHECKPOINT_SEED_SCHEMA,
    version: CHECKPOINT_SEED_VERSION,
    runSlug: DEFAULT_RUN_SLUG,
    releaseCommit: commit,
    manifestObjectPath: normalizedManifestObjectPath,
    expectedCounts: derivedCounts,
    cohortHashes,
    captureSnapshotHashes,
    sourceHashes,
    removedMembership: {
      count: removedIds.length,
      artifactSha256: removedMembership.sha256,
      orderedIdSha256: cohortHashes.removed,
    },
    rows: { count: rows.length, sha256: rowsSha256, order: "coordination-membership-numeric-id" },
    verification: {
      publishedCompleteProvenanceHashesVerified: verifiedProvenance,
      pdfBindingsVerified: evidenceById.size,
      historicalPublishedReceiptsVerified: completeIds.length,
      normalHolds,
      validatorExceptionHolds: exceptionHolds,
      supersededHoldArtifactsIgnored: supersededHolds,
      companyLiveReconciliationFinals: finals.rows.length,
    },
  });
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const manifestSha256 = sha256Bytes(manifestBytes);
  return {
    runSlug: DEFAULT_RUN_SLUG,
    releaseCommit: commit,
    manifestObjectPath: normalizedManifestObjectPath,
    expectedCounts: derivedCounts,
    cohortHashes,
    captureSnapshotHashes,
    sourceHashes,
    removedIds,
    rows,
    rowsBytes,
    rowsSha256,
    manifest,
    manifestBytes,
    manifestSha256,
  };
}

function statusQuery(runSlug, extra = {}) {
  return `${coordinationPath}?${new URLSearchParams({ run: runSlug, ...extra })}`;
}

async function readAllRecords(api, runSlug, filters) {
  const records = [];
  let total = null;
  let offset = 0;
  while (total === null || offset < total) {
    const page = await api.get(statusQuery(runSlug, {
      view: "records",
      ...filters,
      limit: "500",
      offset: String(offset),
    }));
    if (!Array.isArray(page?.records) || !Number.isInteger(page?.total)) {
      throw new Error("checkpoint exact readback returned an invalid current-record page");
    }
    if (total === null) total = page.total;
    if (page.total !== total) throw new Error("checkpoint current-record aggregate changed during readback");
    if (!page.records.length && offset < total) throw new Error("checkpoint current-record readback ended early");
    records.push(...page.records);
    offset += page.records.length;
  }
  return records;
}

/** Full post-finalize exact readback; no row is sampled. */
export async function verifyCheckpointSeedReadback(api, bundle, { expectInitialBoard = true } = {}) {
  const status = await api.get(statusQuery(bundle.runSlug, { events: "20" }));
  const seed = status?.checkpointSeed;
  if (
    seed?.status !== "complete"
    || seed?.manifest_sha256 !== bundle.manifestSha256
    || seed?.release_commit !== bundle.releaseCommit
    || !isDeepStrictEqual(seed?.expected_counts, bundle.expectedCounts)
    || !isDeepStrictEqual(seed?.cohort_hashes, bundle.cohortHashes)
    || !isDeepStrictEqual(seed?.source_hashes, bundle.sourceHashes)
    || Object.hasOwn(seed ?? {}, "seed_token")
  ) throw new Error("checkpoint seed status readback differs from the exact manifest or exposes its token");
  if (status?.run?.completed_checkpoint_seed_id !== seed.id) {
    throw new Error("TAM run is not fenced to the exact completed checkpoint seed");
  }
  if (expectInitialBoard) {
    const expectedBoard = {
      current: bundle.expectedCounts.currentTotal,
      removed: bundle.expectedCounts.removedTotal,
      pdf_verified: bundle.expectedCounts.pdfVerified,
      grade_published: bundle.expectedCounts.publishedComplete,
      grade_pending: bundle.expectedCounts.legacySchemaRecovery
        + bundle.expectedCounts.lostStagingRecovery
        + bundle.expectedCounts.unrepresented,
      grade_hold: bundle.expectedCounts.activeHold,
      grade_reading: 0,
      grade_final: 0,
      lease_expired: 0,
    };
    for (const [field, expected] of Object.entries(expectedBoard)) {
      if (Number(status?.counts?.[field]) !== expected) {
        throw new Error(`checkpoint initial board ${field}=${status?.counts?.[field]}; expected ${expected}`);
      }
    }
    if (status?.run?.status !== "grading") throw new Error("checkpoint finalization did not atomically open grading");
  }

  const actualRecords = await readAllRecords(api, bundle.runSlug, { current: "true" });
  if (actualRecords.length !== bundle.rows.length) throw new Error("checkpoint exact readback current count differs");
  const actualById = new Map();
  for (const record of actualRecords) {
    const internalId = requireExactId(record?.netsuite_internal_id, "Checkpoint readback Internal ID");
    if (actualById.has(internalId)) throw new Error(`checkpoint readback repeats exact ID ${internalId}`);
    actualById.set(internalId, record);
  }
  const idsByCohort = new Map();
  for (const expected of bundle.rows) {
    const actual = actualById.get(expected.netsuiteInternalId);
    if (!actual) throw new Error(`checkpoint readback is missing exact ID ${expected.netsuiteInternalId}`);
    const expectedArtifactSha256 = expected.recoveryCohort === "published_complete"
      || expected.recoveryCohort === "legacy_schema_recovery"
      ? expected.finalAssessmentLineSha256
      : expected.recoveryCohort === "lost_staging_recovery"
        ? expected.historicalReceiptSha256
        : expected.recoveryCohort === "active_hold"
          ? expected.holdFileSha256
          : null;
    const expectedRecordSourceHashes = {
      table_rows_sha256: expected.tableRowsSha256,
      pdf_sha256: expected.pdfSha256,
      pdf_binding_sha256: pdfBindingSha256(expected),
      pdf_capture_snapshot_sha256: expected.pdfCaptureSnapshotSha256,
      ...(["published_complete", "legacy_schema_recovery"].includes(expected.recoveryCohort) ? {
        final_assessment_line_sha256: expected.finalAssessmentLineSha256,
        publish_queue_line_sha256: expected.publishQueueLineSha256,
        ...(expected.historicalReceiptSha256 ? { historical_receipt_sha256: expected.historicalReceiptSha256 } : {}),
      } : {}),
      ...(expected.recoveryCohort === "lost_staging_recovery" ? {
        historical_receipt_sha256: expected.historicalReceiptSha256,
      } : {}),
      ...(expected.recoveryCohort === "active_hold" ? { hold_file_sha256: expected.holdFileSha256 } : {}),
    };
    if (
      Number(actual.membership_ordinal) !== expected.membershipOrdinal
      || actual.recovery_cohort !== expected.recoveryCohort
      || actual.checkpoint_seed_id !== seed.id
      || actual.table_rows_sha256 !== expected.tableRowsSha256
      || actual.checkpoint_artifact_sha256 !== expectedArtifactSha256
      || !sha256Pattern.test(String(actual.checkpoint_payload_sha256 ?? ""))
      || !isDeepStrictEqual(actual.checkpoint_source_hashes, expectedRecordSourceHashes)
      || !Number.isFinite(Date.parse(actual.checkpoint_seeded_at))
      || actual.pdf_status !== "verified"
      || actual.pdf_object_path !== expected.pdfObjectPath
      || actual.pdf_sha256 !== expected.pdfSha256
      || Number(actual.pdf_page_count) !== expected.pdfPageCount
      || Date.parse(actual.pdf_verified_at) !== Date.parse(expected.pdfVerifiedAt)
      || actual.checkpoint_source_hashes?.pdf_capture_snapshot_sha256 !== expected.pdfCaptureSnapshotSha256
    ) throw new Error(`checkpoint exact readback drifted for NetSuite ID ${expected.netsuiteInternalId}`);
    if (expected.recoveryCohort === "published_complete" && (
      actual.grade_status !== "published"
      || Number(actual.final_score) !== expected.finalScore
      || Number(actual.codex_score) !== expected.finalScore
      || actual.grade_provenance_sha256 !== expected.provenance.sha256
      || actual.publication_origin !== "historical_live_import"
      || Date.parse(actual.historical_published_at) !== Date.parse(expected.historicalPublishedAt)
    )) throw new Error(`checkpoint published readback drifted for NetSuite ID ${expected.netsuiteInternalId}`);
    if (expectInitialBoard && expected.recoveryCohort === "active_hold" && (
      actual.grade_status !== "hold" || actual.hold_reason !== expected.holdReason
    )) {
      throw new Error(`checkpoint hold readback drifted for NetSuite ID ${expected.netsuiteInternalId}`);
    }
    if (expectInitialBoard && !["published_complete", "active_hold"].includes(expected.recoveryCohort)
      && actual.grade_status !== "pending") {
      throw new Error(`checkpoint pending readback drifted for NetSuite ID ${expected.netsuiteInternalId}`);
    }
    const cohortIds = idsByCohort.get(expected.recoveryCohort) ?? [];
    cohortIds.push(expected.netsuiteInternalId);
    idsByCohort.set(expected.recoveryCohort, cohortIds);
  }
  const removedRecords = await readAllRecords(api, bundle.runSlug, {
    current: "false",
    membership: "removed",
  });
  if (removedRecords.length !== bundle.removedIds.length) {
    throw new Error("checkpoint exact readback removed count differs");
  }
  const removedIds = removedRecords.map((record) => {
    const internalId = requireExactId(record?.netsuite_internal_id, "Removed checkpoint readback Internal ID");
    if (record?.is_current !== false || record?.membership_status !== "removed") {
      throw new Error(`checkpoint removed readback state drifted for NetSuite ID ${internalId}`);
    }
    return internalId;
  }).sort(exactIdSort);
  if (!isDeepStrictEqual(removedIds, bundle.removedIds)) {
    throw new Error("checkpoint exact removed-ID readback differs from the manifest");
  }
  const readbackHashes = {
    current: orderedIdHash(bundle.rows.map((row) => row.netsuiteInternalId)),
    removed: orderedIdHash(removedIds),
    publishedComplete: orderedIdHash(idsByCohort.get("published_complete") ?? []),
    legacySchemaRecovery: orderedIdHash(idsByCohort.get("legacy_schema_recovery") ?? []),
    lostStagingRecovery: orderedIdHash(idsByCohort.get("lost_staging_recovery") ?? []),
    activeHold: orderedIdHash(idsByCohort.get("active_hold") ?? []),
    unrepresented: orderedIdHash(idsByCohort.get("unrepresented") ?? []),
  };
  if (!isDeepStrictEqual(readbackHashes, bundle.cohortHashes)) {
    throw new Error("checkpoint exact readback ordered-ID hashes drifted");
  }
  return {
    status,
    records: actualRecords.length,
    removedRecords: removedRecords.length,
    cohortHashes: readbackHashes,
  };
}

export async function applyCheckpointSeed({
  api,
  bundle,
  actorKey = "codex",
  batchSize = 100,
  statePath,
  onProgress = (_progress) => {},
}) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new Error("checkpoint batch size must be 1-100");
  }
  const begin = await api.post({
    action: "checkpoint_seed_begin",
    runSlug: bundle.runSlug,
    actorKey,
    manifestSha256: bundle.manifestSha256,
    manifestObjectPath: bundle.manifestObjectPath,
    releaseCommit: bundle.releaseCommit,
    expectedCounts: bundle.expectedCounts,
    cohortHashes: bundle.cohortHashes,
    captureSnapshotHashes: bundle.captureSnapshotHashes,
    sourceHashes: bundle.sourceHashes,
  });
  const seedToken = requireText(begin?.seed?.seedToken, "checkpoint seed token");
  const seedId = requireText(begin?.seed?.seedId, "checkpoint seed ID");
  const completed = begin?.seed?.status === "complete";
  let state = {
    schema: `${CHECKPOINT_SEED_SCHEMA}-apply-state`,
    version: CHECKPOINT_SEED_VERSION,
    runSlug: bundle.runSlug,
    seedId,
    manifestSha256: bundle.manifestSha256,
    rowsSha256: bundle.rowsSha256,
    confirmedPrefix: 0,
    status: completed ? "complete" : "seeding",
  };
  if (statePath) {
    try {
      const prior = JSON.parse(await readFile(statePath, "utf8"));
      if (
        prior?.schema !== state.schema
        || prior?.version !== state.version
        || prior?.runSlug !== state.runSlug
        || prior?.seedId !== seedId
        || prior?.manifestSha256 !== bundle.manifestSha256
        || prior?.rowsSha256 !== bundle.rowsSha256
        || !Number.isInteger(prior?.confirmedPrefix)
        || prior.confirmedPrefix < 0
        || prior.confirmedPrefix > bundle.rows.length
      ) throw new Error("existing checkpoint apply state belongs to a different immutable seed");
      state = { ...state, ...prior };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (!completed) {
    for (let offset = state.confirmedPrefix; offset < bundle.rows.length; offset += batchSize) {
      const rows = bundle.rows.slice(offset, offset + batchSize);
      const response = await api.post({
        action: "checkpoint_seed_batch",
        runSlug: bundle.runSlug,
        actorKey,
        seedToken,
        rows,
      });
      if (response?.seed?.seedId !== seedId) throw new Error("checkpoint batch returned a different seed ID");
      state.confirmedPrefix = offset + rows.length;
      state.status = "seeding";
      if (statePath) await atomicWriteJson(statePath, state);
      onProgress({ phase: "seed", completed: state.confirmedPrefix, total: bundle.rows.length });
    }
  }
  const finalized = await api.post({
    action: "checkpoint_seed_finalize",
    runSlug: bundle.runSlug,
    actorKey,
    seedToken,
  });
  if (finalized?.seed?.seedId !== seedId || finalized?.seed?.status !== "complete") {
    throw new Error("checkpoint finalization did not return the exact completed seed");
  }
  const readback = await verifyCheckpointSeedReadback(api, bundle, { expectInitialBoard: !completed });
  state.confirmedPrefix = bundle.rows.length;
  state.status = "complete";
  state.completedAt = new Date().toISOString();
  state.readbackRecords = readback.records;
  state.cohortHashes = readback.cohortHashes;
  if (statePath) await atomicWriteJson(statePath, state);
  return { seedId, alreadyComplete: completed, readback, state };
}

export function parseCheckpointArgs(argv) {
  const valueOptions = new Set([
    "refresh-root",
    "evidence-state",
    "evidence-receipt",
    "release-commit",
    "output-dir",
    "manifest-object-path",
    "base-url",
    "auth-mode",
    "actor",
    "batch-size",
    "confirm",
  ]);
  const booleanOptions = new Set(["apply"]);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) throw new Error(`Unexpected positional argument ${value}`);
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
  return parsed;
}

async function main() {
  const startedAt = new Date().toISOString();
  const args = parseCheckpointArgs(process.argv.slice(2));
  const outputDirectory = path.resolve(requireText(args["output-dir"], "--output-dir"));
  const receiptPath = path.join(outputDirectory, "checkpoint_seed_receipt.json");
  const manifestPath = path.join(outputDirectory, "checkpoint_seed_manifest.json");
  const rowsPath = path.join(outputDirectory, "checkpoint_seed_rows.jsonl");
  const statePath = path.join(outputDirectory, "checkpoint_seed_apply_state.json");
  let receipt = {
    schema: `${CHECKPOINT_SEED_SCHEMA}-receipt`,
    version: CHECKPOINT_SEED_VERSION,
    mode: args.apply ? "apply" : "dry-run",
    startedAt,
    completedAt: null,
    stopReason: "validation_failed",
    result: null,
    error: null,
  };
  try {
    const paths = checkpointPaths(
      requireText(args["refresh-root"], "--refresh-root"),
      requireText(args["evidence-state"], "--evidence-state"),
      requireText(args["evidence-receipt"], "--evidence-receipt"),
    );
    const bundle = await buildCheckpointSeedBundle({
      paths,
      releaseCommit: requireText(args["release-commit"], "--release-commit"),
      manifestObjectPath: args["manifest-object-path"] ?? `${DEFAULT_RUN_SLUG}/checkpoint-seed-manifest.json`,
      onProgress(progress) {
        if (progress.phase === "provenance") console.log(`verified ${progress.verified}/2696 Python-canonical provenance hashes`);
      },
    });
    await Promise.all([
      atomicWrite(manifestPath, bundle.manifestBytes),
      atomicWrite(rowsPath, bundle.rowsBytes),
    ]);
    const publicSummary = {
      runSlug: bundle.runSlug,
      manifestPath,
      manifestSha256: bundle.manifestSha256,
      rowsPath,
      rowsSha256: bundle.rowsSha256,
      rows: bundle.rows.length,
      expectedCounts: bundle.expectedCounts,
      cohortHashes: bundle.cohortHashes,
      provenanceHashesVerified: bundle.manifest.verification.publishedCompleteProvenanceHashesVerified,
      pdfBindingsVerified: bundle.manifest.verification.pdfBindingsVerified,
    };
    if (!args.apply) {
      receipt.completedAt = new Date().toISOString();
      receipt.stopReason = "worklist_exhausted";
      receipt.result = { ...publicSummary, externalActionsAttempted: 0, externalActionsConfirmed: 0 };
      await atomicWriteJson(receiptPath, receipt);
      console.log(JSON.stringify({ ok: true, mode: "dry-run", receiptPath, ...publicSummary }, null, 2));
      return;
    }
    if (args.confirm !== CHECKPOINT_SEED_APPLY_CONFIRMATION) {
      throw new Error(`Apply mode requires --confirm ${CHECKPOINT_SEED_APPLY_CONFIRMATION}`);
    }
    const api = createCoordinationApi({
      baseUrl: args["base-url"] ?? process.env.TAM_COORDINATION_BASE_URL ?? process.env.APP_BASE_URL,
      agentToken: process.env.AGENT_TOKEN,
      authMode: args["auth-mode"] ?? "agent-header",
    });
    const result = await applyCheckpointSeed({
      api,
      bundle,
      actorKey: args.actor ?? process.env.TAM_ACTOR_KEY ?? "codex",
      batchSize: Number(args["batch-size"] ?? 100),
      statePath,
      onProgress(progress) {
        console.log(`seeded ${progress.completed}/${progress.total}`);
      },
    });
    receipt.completedAt = new Date().toISOString();
    receipt.stopReason = "worklist_exhausted";
    receipt.result = { ...publicSummary, seedId: result.seedId, alreadyComplete: result.alreadyComplete };
    await atomicWriteJson(receiptPath, receipt);
    console.log(JSON.stringify({ ok: true, mode: "apply", receiptPath, ...receipt.result }, null, 2));
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
