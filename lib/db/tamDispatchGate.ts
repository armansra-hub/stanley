import "server-only";
import { z } from "zod";
import { serviceClient } from "@/lib/supabase/server";

const runSlug = z.string().min(1).max(200);
const readSchema = z.object({ runSlug, seedId: z.string().uuid().optional() });
const setSchema = z.object({
  action: z.literal("dispatch_gate_set"), runSlug, seedId: z.string().uuid(), operationId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  expectedPaused: z.boolean(), paused: z.boolean(), actorKey: z.string().trim().min(1).max(80),
}).strict();
export type TamDispatchGate = { runId: string; runSlug: string; seedId: string | null; paused: boolean; revision: number; operationId: string | null; updatedAt: string | null };

export function isTamPendingDispatchSelector(params: URLSearchParams) {
  return params.get("view") === "records" && params.get("current") === "true"
    && params.get("pdf") === "verified" && params.get("grade") === "pending" && !params.get("id");
}

export async function getTamDispatchGate(raw: { runSlug: string; seedId?: string }): Promise<TamDispatchGate> {
  const input = readSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("tam_dispatch_gate_status", { p_run_slug: input.runSlug, p_seed_id: input.seedId ?? null });
  if (error) throw new Error(`TAM dispatch gate read failed: ${error.message}`);
  if (!data || typeof data.paused !== "boolean" || data.runSlug !== input.runSlug || !Number.isSafeInteger(data.revision))
    throw new Error("TAM dispatch gate returned invalid state");
  return data as TamDispatchGate;
}

export async function setTamDispatchGate(raw: unknown) {
  const input = setSchema.parse(raw);
  const { data, error } = await serviceClient().rpc("tam_set_dispatch_gate", {
    p_run_slug: input.runSlug, p_seed_id: input.seedId, p_operation_id: input.operationId,
    p_expected_revision: input.expectedRevision, p_expected_paused: input.expectedPaused,
    p_paused: input.paused, p_actor_key: input.actorKey,
  });
  if (error) throw new Error(`TAM dispatch gate write failed: ${error.message}`);
  return data;
}
