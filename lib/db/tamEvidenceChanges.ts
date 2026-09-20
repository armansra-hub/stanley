import "server-only";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";

export const tamEvidenceAdmissionSchema = z.object({ action: z.literal("evidence_change_admit"),
  runSlug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,99}$/), evidenceIndexSha256: z.string().regex(/^[a-f0-9]{64}$/),
  bindings: z.array(z.object({ receiptId: z.string().uuid(), recordTextSha256: z.string().regex(/^[a-f0-9]{64}$/), pdfSha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(200),
}).superRefine((input, ctx) => { if (new Set(input.bindings.map(b => b.receiptId)).size !== input.bindings.length) ctx.addIssue({ code: "custom", message: "Duplicate change receipt" }); });

export async function listTamEvidenceChanges(internalId?: string, offset = 0) {
  if (internalId && !/^\d+$/.test(internalId)) throw new Error("Invalid exact Internal ID");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid evidence-change offset");
  let query = serviceClient().from("tam_evidence_change_receipts").select("*", { count: "exact" })
    .in("status", ["observed", "admitted"]).order("observed_at").order("id").range(offset, offset + 99);
  if (internalId) query = query.eq("netsuite_internal_id", internalId);
  const { data, error, count } = await query;
  if (error) throw new Error("TAM evidence-change receipts unavailable");
  return { changes: data ?? [], total: count, offset, scope: "Evidence receipts only; canonical coordinator owns grading and publication." };
}
export async function admitTamEvidenceChanges(raw: unknown) {
  const input = tamEvidenceAdmissionSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("tam_admit_changed_evidence", { p_successor: input.runSlug,
    p_evidence_index_sha256: input.evidenceIndexSha256, p_bindings: input.bindings });
  if (error) throw new Error("TAM changed-evidence admission failed");
  return data;
}
