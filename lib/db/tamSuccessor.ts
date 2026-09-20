import "server-only";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";
import { bootstrapTamRunSchema, tamCheckpointSeedBeginSchema } from "@/lib/tamRegrade";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[0-9]+$/);
export const changedSuccessorSchema = z.object({
  action: z.literal("evidence_successor_initialize"),
  predecessorRunSlug: z.string().min(1).max(200),
  predecessorSeedId: z.string().uuid(),
  bootstrap: bootstrapTamRunSchema.omit({ status: true }).extend({ sourceTotal: z.number().int().positive(), sourceSnapshotSha256: hash }),
  seed: tamCheckpointSeedBeginSchema,
  manifestCanonicalJson: z.string().min(2).max(100_000),
  expectedPredecessorBindings: z.array(z.object({ internalId: id, sha256: hash }).strict()).min(1).max(10_000),
  changes: z.array(z.object({
    receiptId: z.string().uuid(), internalId: id, recordTextSha256: hash,
    pdfObjectPath: z.string().min(1).max(2048).refine(path => !/^[\\/]|^[a-z]:|[\r\n\0]|(^|[\\/])\.\.([\\/]|$)/i.test(path), "relative immutable PDF locator required"),
    pdfSha256: hash, pdfPageCount: z.number().int().positive().max(100_000),
    pdfVerifiedAt: z.string().datetime({ offset: true }), pdfCaptureSnapshotSha256: hash,
  }).strict()).min(1).max(200),
}).strict();

export async function initializeChangedSuccessor(raw: unknown) {
  if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 4_000_000) throw new Error("Changed successor request exceeds 4 MB");
  const input = changedSuccessorSchema.parse(raw);
  if (input.bootstrap.runSlug !== input.seed.runSlug || input.bootstrap.runSlug === input.predecessorRunSlug)
    throw new Error("Distinct successor and exact seed run required");
  let manifest: Record<string, unknown>;
  try { manifest = JSON.parse(input.manifestCanonicalJson); } catch { throw new Error("Invalid canonical successor manifest JSON"); }
  if (!manifest || Array.isArray(manifest) || manifest.schema !== "tam-successor-checkpoint-manifest"
    || manifest.runSlug !== input.seed.runSlug || manifest.historicalRunSlug !== input.predecessorRunSlug
    || createHash("sha256").update(input.manifestCanonicalJson, "utf8").digest("hex") !== input.seed.manifestSha256)
    throw new Error("Exact canonical successor manifest differs");
  for (const key of ["releaseCommit", "expectedCounts", "cohortHashes", "captureSnapshotHashes", "sourceHashes"] as const)
    if (!isDeepStrictEqual(manifest[key], input.seed[key])) throw new Error(`Successor manifest ${key} differs`);
  if (new Set(input.expectedPredecessorBindings.map(row => row.internalId)).size !== input.expectedPredecessorBindings.length
    || new Set(input.changes.map(row => row.internalId)).size !== input.changes.length
    || new Set(input.changes.map(row => row.receiptId)).size !== input.changes.length)
    throw new Error("Duplicate successor bindings");
  const { data, error } = await serviceClient().rpc("tam_initialize_changed_successor", { p_input: input });
  if (error) throw new Error(`Changed successor initialization failed: ${error.message}`);
  return data;
}
