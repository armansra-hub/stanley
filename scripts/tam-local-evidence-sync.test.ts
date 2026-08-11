import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  applyEvidenceCorpus,
  runTrustedPdfAudit,
  validateEvidenceCorpus,
} from "./tam-local-evidence-sync.mjs";

function sha256(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function csv(rows: Array<Array<string | number>>) {
  return `${rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n")}\n`;
}

async function syntheticPdfAuditor(records: Array<any>) {
  const results = [];
  for (const record of records) {
    const bytes = await readFile(record.pdfPath);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !/%%EOF\s*$/.test(bytes.toString("latin1"))) {
      throw new Error(`invalid PDF envelope for ${record.netsuiteInternalId}`);
    }
    results.push({
      netsuiteInternalId: record.netsuiteInternalId,
      sha256: sha256(bytes),
      pageCount: (bytes.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length,
      bytes: bytes.length,
      stableStat: { size: bytes.length, mtimeNs: 1, device: 1, inode: 1 },
    });
  }
  return results;
}

function validMinimalPdf(pageCount: number) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...Array.from({ length: pageCount }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, "ascii"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "ascii");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

async function makeEvidenceFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "tam-local-evidence-"));
  const evidenceRoot = path.join(root, "evidence");
  const membershipPath = path.join(root, "membership.csv");
  const inventoryPath = path.join(root, "inventory.csv");
  const ids = ["101", "202"];
  const inventoryRows: Array<Array<string | number>> = [[
    "Internal ID",
    "Captured At UTC",
    "PDF Path",
    "PDF SHA256",
    "PDF Pages",
    "PDF Bytes",
    "Capture Metadata Path",
    "Capture Metadata SHA256",
    "Capture Snapshot SHA256",
  ]];
  for (const [index, internalId] of ids.entries()) {
    const directory = path.join(evidenceRoot, "leads", internalId);
    await mkdir(directory, { recursive: true });
    const pdf = Buffer.from(`%PDF-1.4\n${internalId}\n${"/Type /Page\n".repeat(index + 1)}%%EOF\n`, "ascii");
    const pdfPath = path.join(directory, "print.pdf");
    const capturePath = path.join(directory, "capture.json");
    const capturedAt = `2026-08-0${index + 1}T12:00:00.000Z`;
    const snapshotSha256 = String(index + 1).repeat(64);
    const capture = {
      schema: "tam-current-lead-record-capture",
      version: 1,
      status: "verified",
      internal_id: internalId,
      captured_at_utc: capturedAt,
      snapshot_sha256: snapshotSha256,
      pdf: {
        path: `leads/${internalId}/print.pdf`,
        bytes: pdf.length,
        sha256: sha256(pdf),
        page_count: index + 1,
      },
    };
    const captureBytes = `${JSON.stringify(capture, null, 2)}\n`;
    await Promise.all([
      writeFile(pdfPath, pdf),
      writeFile(capturePath, captureBytes),
    ]);
    inventoryRows.push([
      internalId,
      capturedAt,
      pdfPath,
      sha256(pdf),
      index + 1,
      pdf.length,
      capturePath,
      sha256(captureBytes),
      snapshotSha256,
    ]);
  }
  await Promise.all([
    writeFile(membershipPath, csv([["Internal ID"], ...ids.map((id) => [id])])),
    writeFile(inventoryPath, csv(inventoryRows)),
  ]);
  return { root, evidenceRoot, membershipPath, inventoryPath, ids };
}

describe("local TAM evidence sync", () => {
  it("serially validates exact-ID directories, PDF envelopes, hashes, pages, and capture times", async () => {
    const fixture = await makeEvidenceFixture();
    const progress: string[] = [];
    const corpus = await validateEvidenceCorpus({
      membershipPath: fixture.membershipPath,
      inventoryPath: fixture.inventoryPath,
      evidenceRoot: fixture.evidenceRoot,
      expectedCount: 2,
      pdfAuditor: syntheticPdfAuditor,
      onProgress: ({ phase, internalId }) => {
        if (phase === "validate") progress.push(internalId);
      },
    });
    expect(progress).toEqual(fixture.ids);
    expect(corpus.entries.map((entry) => entry.locator)).toEqual([
      "leads/101/print.pdf",
      "leads/202/print.pdf",
    ]);
    expect(corpus.entries.map((entry) => entry.captureSnapshotSha256)).toEqual([
      "1".repeat(64),
      "2".repeat(64),
    ]);
    expect(corpus.totalPdfPages).toBe(3);
  });

  it("fails the whole local validation before registration when the PDF EOF is invalid", async () => {
    const fixture = await makeEvidenceFixture();
    const pdfPath = path.join(fixture.evidenceRoot, "leads", "202", "print.pdf");
    await writeFile(pdfPath, "%PDF-1.4\ntruncated");
    await expect(validateEvidenceCorpus({
      membershipPath: fixture.membershipPath,
      inventoryPath: fixture.inventoryPath,
      evidenceRoot: fixture.evidenceRoot,
      expectedCount: 2,
      pdfAuditor: syntheticPdfAuditor,
    })).rejects.toThrow(/byte count|EOF|SHA-256|PDF envelope/);
  });

  it("registers one exact relative locator at a time and persists an atomic prefix fence", async () => {
    const fixture = await makeEvidenceFixture();
    const corpus = await validateEvidenceCorpus({
      membershipPath: fixture.membershipPath,
      inventoryPath: fixture.inventoryPath,
      evidenceRoot: fixture.evidenceRoot,
      expectedCount: 2,
      pdfAuditor: syntheticPdfAuditor,
    });
    const records = new Map<string, Record<string, any>>(corpus.entries.map((entry) => [entry.netsuiteInternalId, {
      netsuite_internal_id: entry.netsuiteInternalId,
      is_current: true,
      pdf_status: "missing",
      pdf_object_path: null,
      pdf_sha256: null,
      pdf_page_count: null,
      pdf_verified_at: null,
      pdf_error: null,
    }]));
    const actions: string[] = [];
    const api = {
      post: vi.fn(async (body: any) => {
        actions.push(`${body.action}:${body.netsuiteInternalId}`);
        const record = records.get(body.netsuiteInternalId)!;
        Object.assign(record, {
          pdf_status: body.status,
          pdf_object_path: body.objectPath,
          pdf_sha256: body.sha256,
          pdf_page_count: body.pageCount,
          pdf_verified_at: body.verifiedAt,
          pdf_error: null,
        });
        return { record };
      }),
      get: vi.fn(async (relativePath: string) => {
        const url = new URL(relativePath, "https://stanley.example");
        if (url.searchParams.get("view") === "records") {
          const internalId = url.searchParams.get("id");
          if (internalId) {
            const record = records.get(internalId);
            return { records: record ? [record] : [], total: record ? 1 : 0, limit: 2, offset: 0 };
          }
          const all = [...records.values()];
          return { records: all, total: all.length, limit: 500, offset: 0 };
        }
        return { counts: { current: 2, pdf_verified: 2 } };
      }),
    };
    const statePath = path.join(fixture.root, "state.json");
    const result = await applyEvidenceCorpus({ api, corpus, statePath });
    expect(actions).toEqual(["pdf:101", "pdf:202"]);
    expect(result).toMatchObject({ confirmedTotal: 2, registeredThisRun: 2, alreadyExactThisRun: 0 });
    const state = JSON.parse(await readFile(statePath, "utf8"));
    expect(state).toMatchObject({ status: "complete", confirmedPrefix: 2 });
    expect(state.lastConfirmed.locator).toBe("leads/202/print.pdf");
    expect(state.evidenceReadbackSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(state)).not.toContain(fixture.evidenceRoot);

    records.get("101")!.pdf_sha256 = "f".repeat(64);
    await expect(applyEvidenceCorpus({ api, corpus, statePath })).rejects.toThrow("Resume prefix live evidence drifted");
    const blockedState = JSON.parse(await readFile(statePath, "utf8"));
    expect(blockedState).toMatchObject({ status: "blocked", confirmedPrefix: 2 });
  });

  const trustedAuditIt = process.env.TAM_PDF_PYTHON ? it : it.skip;
  trustedAuditIt("recomputes actual pages with pypdf and returns a stable stat fence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "tam-trusted-pdf-audit-"));
    const pdfPath = path.join(root, "print.pdf");
    const pdf = validMinimalPdf(3);
    await writeFile(pdfPath, pdf);
    const [result] = await runTrustedPdfAudit({
      pythonPath: process.env.TAM_PDF_PYTHON,
      records: [{ netsuiteInternalId: "101", pdfPath }],
    });
    expect(result).toMatchObject({
      netsuiteInternalId: "101",
      sha256: sha256(pdf),
      pageCount: 3,
      bytes: pdf.length,
    });
    expect(result.stableStat).toBeTruthy();
  });
});
