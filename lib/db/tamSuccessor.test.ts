import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
import { initializeChangedSuccessor } from "./tamSuccessor";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function request() {
  const expectedCounts = { currentTotal: 2, removedTotal: 0, pdfVerified: 2, publishedComplete: 1, legacySchemaRecovery: 0, lostStagingRecovery: 0, activeHold: 0, unrepresented: 1 };
  const cohortHashes = Object.fromEntries(["current", "removed", "publishedComplete", "legacySchemaRecovery", "lostStagingRecovery", "activeHold", "unrepresented"].map(key => [key, hash(key)]));
  const manifest = { schema: "tam-successor-checkpoint-manifest", runSlug: "next", historicalRunSlug: "old", releaseCommit: "a".repeat(40), expectedCounts, cohortHashes, captureSnapshotHashes: { current: hash("capture"), allowedPrior: [] }, sourceHashes: { evidenceIndex: hash("index") } };
  const canonical = JSON.stringify(manifest) + "\n";
  return { action: "evidence_successor_initialize", predecessorRunSlug: "old", predecessorSeedId: "11111111-1111-4111-8111-111111111111",
    bootstrap: { runSlug: "next", searchId: "1327786", mission: {}, sourceTotal: 2, sourceSnapshotSha256: hash("capture") },
    seed: { runSlug: "next", actorKey: "codex", manifestSha256: hash(canonical), manifestObjectPath: "next/manifest.json", releaseCommit: manifest.releaseCommit, expectedCounts, cohortHashes, captureSnapshotHashes: manifest.captureSnapshotHashes, sourceHashes: manifest.sourceHashes },
    manifestCanonicalJson: canonical, expectedPredecessorBindings: [{ internalId: "1", sha256: hash("one") }, { internalId: "2", sha256: hash("two") }],
    changes: [{ receiptId: "22222222-2222-4222-8222-222222222222", internalId: "1", recordTextSha256: hash("text"), pdfObjectPath: "fresh/1/print.pdf", pdfSha256: hash("pdf"), pdfPageCount: 2, pdfVerifiedAt: "2026-09-20T10:00:00Z", pdfCaptureSnapshotSha256: hash("capture") }] };
}
beforeEach(() => { mocks.rpc.mockReset(); mocks.rpc.mockResolvedValue({ data: { copied: 2, changed: 1, seed: { status: "building" } }, error: null }); });
it("sends one atomic RPC with the exact manifest and bounded bindings", async () => {
  const input = request(); expect(await initializeChangedSuccessor(input)).toMatchObject({ copied: 2, changed: 1 });
  expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.rpc).toHaveBeenCalledWith("tam_initialize_changed_successor", { p_input: input });
});
it("rejects altered manifest bytes before any database write", async () => {
  const input = request(); input.manifestCanonicalJson += " "; await expect(initializeChangedSuccessor(input)).rejects.toThrow("manifest differs"); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejects different counts hidden behind a valid manifest hash", async () => {
  const input = request(); input.seed.expectedCounts.publishedComplete = 0; input.seed.expectedCounts.unrepresented = 2; await expect(initializeChangedSuccessor(input)).rejects.toThrow("expectedCounts differs"); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejects duplicate exact IDs", async () => {
  const input = request(); input.expectedPredecessorBindings.push(input.expectedPredecessorBindings[0]); await expect(initializeChangedSuccessor(input)).rejects.toThrow("Duplicate successor"); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("rejects escaped PDF locators and excessive changes", async () => {
  const input = request(); input.changes[0].pdfObjectPath = "../old/print.pdf"; await expect(initializeChangedSuccessor(input)).rejects.toThrow();
  const many = request(); many.changes = Array.from({ length: 201 }, () => many.changes[0]); await expect(initializeChangedSuccessor(many)).rejects.toThrow(); expect(mocks.rpc).not.toHaveBeenCalled();
});
it("reports fenced database refusal without retrying", async () => {
  mocks.rpc.mockResolvedValue({ data: null, error: { message: "predecessor exact evidence binding changed" } });
  await expect(initializeChangedSuccessor(request())).rejects.toThrow("predecessor exact evidence binding changed"); expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
