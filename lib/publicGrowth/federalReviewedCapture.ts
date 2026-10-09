import "server-only";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { serviceClient } from "@/lib/supabase/server";
import { beginPublicGrowthSweep, failPublicGrowthSweep, type PublicGrowthSweepLease } from "./sweepState";
import { readFederalDiscoveryContinuations } from "./federalDiscoveryState";

const SOURCE = "federal-discovery";
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const federalReviewedCaptureSchema = z.object({ operationId: uuid, companyId: uuid,
  expectedContinuationSha256: hash, jobId: uuid, finishEventId: uuid, snapshotHash: hash, decisionHash: hash,
  manualRunCutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
}).strict();
type Request = z.infer<typeof federalReviewedCaptureSchema>;

/** SQL's explicit JSONB hash encoding avoids translating arbitrary cursor keys. */
export async function inspectFederalReviewedCapture(companyId: string) {
  uuid.parse(companyId);
  const { data, error } = await serviceClient().rpc("inspect_federal_reviewed_capture", { p_company_id: companyId });
  if (error || !data || data.companyId !== companyId || data.hashEncoding !== "postgres-jsonb-text-v1") throw new Error("reviewed capture inspection unavailable");
  return data;
}
async function readEvent(operationId: string) {
  const { data, error } = await serviceClient().from("app_events").select("id,module,kind,entity_type,entity_id,summary,meta").eq("id", operationId).maybeSingle();
  if (error) throw new Error("review consumption event readback unavailable");
  return data;
}
function receipt(event: Awaited<ReturnType<typeof readEvent>>, request: Request) {
  if (!event || event.id !== request.operationId || event.module !== "headhunter" || event.kind !== "federal.discovery.capture_review_consumed"
    || event.entity_type !== "cron" || event.entity_id !== SOURCE || !isDeepStrictEqual(event.meta?.request, request)
    || typeof event.summary !== "string" || !event.summary.trim()
    || event.meta.eventId !== event.id || event.meta.companyComplete !== false || event.meta.historyComplete !== false
    || event.meta.recipientIdentityVerified !== false || event.meta.coverageVerified !== false || event.meta.completionScope !== "source_capture"
    || event.meta.sourceRequests !== 0 || event.meta.attemptsCredited !== 0 || event.meta.triggers !== 0) throw new Error("review consumption receipt mismatch; never replay");
  return event.meta;
}

/** One provider-free transaction consumes an already finished canonical job.
 * The original operator hold remains present; scheduled discovery stays stopped. */
export async function consumeFederalReviewedCapture(request: Request) {
  federalReviewedCaptureSchema.parse(request);
  const prior = await readEvent(request.operationId);
  if (prior) return { ...receipt(prior, request), reusedReceipt: true, exactEventVerified: true };
  let lease: PublicGrowthSweepLease | undefined;
  try {
    lease = await beginPublicGrowthSweep(SOURCE, 1, null);
    readFederalDiscoveryContinuations(lease.cursor);
    const { data, error } = await serviceClient().rpc("consume_federal_reviewed_capture", { p_request: request, p_lease_token: lease.token });
    if (error || !data) throw new Error("review consumption transaction requires readback");
    const saved = receipt(await readEvent(request.operationId), request);
    if (!isDeepStrictEqual(data, saved)) throw new Error("review consumption transaction readback mismatch");
    if (!await failPublicGrowthSweep(lease, new Error("manual_source_only_company_and_history_incomplete"))) throw new Error("review consumption lease release uncertain");
    lease = undefined;
    const after = await inspectFederalReviewedCapture(request.companyId);
    if (after.leaseToken !== null || after.leaseUntil !== null || after.cursorSha256 !== saved.afterCursorSha256 || !isDeepStrictEqual(after.continuation, saved.nextContinuation)
      || !isDeepStrictEqual(after.manualSourceOnly, saved.manualSourceOnly)) throw new Error("review consumption state readback mismatch");
    return { ...saved, reusedReceipt: false, exactEventVerified: true, exactStateVerified: true };
  } catch (error) {
    if (lease) await failPublicGrowthSweep(lease, new Error("review_consumption_requires_exact_readback")).catch(() => false);
    throw error;
  }
}
