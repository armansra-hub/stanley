import { NextResponse } from "next/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { newsActionSchema, newsRpc, publicNewsPacket, validateNewsAnalysis, validateNewsReview, verifyNewsCompletion, NewsReviewError } from "@/lib/intelligence/codexNews";
import { ZodError } from "zod";
import { recomputePriority } from "@/lib/db/triggers";
import { reheatCompanyForFreshSignal } from "@/lib/db/reheat";
import { isDeepStrictEqual } from "node:util";
import type { NewsPacket } from "@/lib/intelligence/codexNews";
import { isPublishableTriggerForCompany } from "@/lib/triggers/signalIntegrity";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const json = (data: unknown, status = 200) => NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
function authorized(req: Request) { return agentAuthOk(req) && req.headers.get("x-agent-name") === "codex"; }
function failure(error: unknown) {
  if (error instanceof ZodError || error instanceof SyntaxError) return json({ error: "invalid_news_review_request" }, 400);
  return json({ error: error instanceof NewsReviewError ? error.message : "news_review_unavailable", recovery: "Read exact jobId or requestId before any retry." }, 409);
}
async function refreshWorklist(packet: NewsPacket) {
  const trigger = packet.publication?.trigger;
  const source = packet.snapshot.observation;
  if (packet.review.receipt?.disposition === "publish" && trigger && source.is_current && !source.feedback_excluded
    && isPublishableTriggerForCompany(trigger, packet.snapshot.company)) {
    await reheatCompanyForFreshSignal(packet.snapshot.company.id, trigger.type, trigger.source_url, trigger.signal_date, { strict: true });
    await recomputePriority(packet.snapshot.company.id);
  }
}
/** Read-only exact recovery after an uncertain claim/finish. Never claims another job. */
export async function GET(req: Request) {
  if (!authorized(req)) return unauthorized();
  const params = new URL(req.url).searchParams;
  const jobId = params.get("jobId"), requestId = params.get("requestId");
  if ((!jobId && !requestId) || [jobId, requestId].some(v => v && !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(v))) return json({ error: "exact_job_or_request_required" }, 400);
  try { return json({ job: publicNewsPacket(await newsRpc("status", { ...(jobId ? { jobId } : {}), ...(requestId ? { requestId } : {}) })) }); }
  catch (error) { return failure(error); }
}
export async function POST(req: Request) {
  if (!authorized(req)) return unauthorized();
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > 64_000) return json({ error: "request_too_large" }, 413);
    const body = newsActionSchema.parse(JSON.parse(text));
    if (body.action === "claim") return json({ job: publicNewsPacket(await newsRpc("claim", body)) });
    if (body.action === "renew") return json({ job: publicNewsPacket(await newsRpc("renew", body)) });
    const packet = await newsRpc("read", body);
    if (!packet) return json({ error: "news_job_not_found" }, 404);
    if (body.action === "finish" && packet.status === "complete") {
      // A successful reheat can change the company-status snapshot after the
      // atomic finish. Resolve the exact saved receipt, never re-analyze/reinsert.
      if (body.snapshotHash !== packet.review.receipt?.snapshotHash || !isDeepStrictEqual(body.review, packet.review.independentReview)) throw new NewsReviewError("completion_retry_differs");
      verifyNewsCompletion(packet, body.review.decisionHash);
      await refreshWorklist(packet);
      return json({ job: publicNewsPacket(packet) });
    }
    if (body.action === "hold") return json({ job: publicNewsPacket(await newsRpc("hold", body)) });
    if (body.action === "analyze") {
      const checked = validateNewsAnalysis(packet, body.analysis);
      return json({ job: publicNewsPacket(await newsRpc("analyze", { ...body, analysis: checked.analysis, decisionHash: checked.decisionHash })) });
    }
    const checked = validateNewsReview(packet, body.review);
    const saved = await newsRpc("finish", { ...body, trigger: checked.trigger, routeReason: checked.routeReason });
    // Read by exact job identity, and compare the stored operation receipt. A lost
    // response never authorizes publishing or claiming a second time blindly.
    const readback = await newsRpc("status", { jobId: body.jobId });
    if (!saved?.review.receipt || !readback?.review.receipt || JSON.stringify(saved.review.receipt) !== JSON.stringify(readback.review.receipt)
      || readback.status !== "complete" || readback.review.decisionHash !== checked.decisionHash) throw new NewsReviewError("news_finish_readback_unconfirmed");
    verifyNewsCompletion(readback, checked.decisionHash);
    await refreshWorklist(readback);
    return json({ job: publicNewsPacket(readback) });
  } catch (error) { return failure(error); }
}
