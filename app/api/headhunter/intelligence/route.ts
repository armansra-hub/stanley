import { NextRequest, NextResponse, after } from "next/server";
import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { recomputePriority } from "@/lib/db/triggers";
import { readJevCostMetrics } from "@/lib/intelligence/costMetrics";
import { runAccountQuestionWorker } from "@/lib/intelligence/accountQuestions";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const empty = { enabled: false, views: [], observations: [], hasMore: false,
  spend: { available: false, usedUsd: 0, reservedUsd: 0, limitUsd: 20 }, jobs: { queued: 0, running: 0, failed: 0 },
  sourceCoverage: { complete: 0, partial: 0, failed: 0 } };
type ReadStage = "client" | "status" | "health" | "views" | "observations" | "feedback" | "response";

// Monitoring is optional for browsing. Bound its storage requests so a large
// queue or unavailable aggregate cannot hide saved evidence behind a timeout.
async function optionalMetric<T, F>(read: () => PromiseLike<T>, fallback: F): Promise<T | F> {
  try { return await withServiceDeadline(Date.now() + 2_500, async () => await read()); }
  catch { return fallback; }
}

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const params = req.nextUrl.searchParams;
  const companyId = params.get("companyId"), viewId = params.get("viewId");
  const scope = params.get("scope");
  const accountScope = scope === "account";
  const dismissed = params.get("dismissed") === "true";
  const offset = Number(params.get("offset") ?? 0);
  if ((scope && scope !== "account") || (accountScope && !companyId) || (companyId && !isUuid(companyId)) || (viewId && !isUuid(viewId)) || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  }
  // The processing switch controls writes and model work, never stored reads.
  let stage: ReadStage = "client";
  let code = "unknown";
  const fail = (failedStage: ReadStage, error: unknown): never => {
    stage = failedStage;
    const value = error && typeof error === "object" && "code" in error ? error.code : null;
    // Only standard SQLSTATE/PostgREST identifiers. Never emit provider messages,
    // details, hints, response bodies, query values or credentials.
    code = typeof value === "string" && /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/.test(value) ? value : "unknown";
    throw new Error("intelligence_read_failed");
  };
  try {
    const db = serviceClient();
    stage = "status";
    const [status, views, health, jevCost] = await Promise.all([
      accountScope ? Promise.resolve({ data: { enabled: intelligenceEnabled() }, error: null }) : optionalMetric(
        () => serviceClient().rpc("intelligence_status"), { data: null, error: { message: "metrics_unavailable" } }),
      accountScope ? Promise.resolve({ data: [], error: null }) : db.from("intelligence_views").select("id,name,question,active,backfill_complete").eq("active", true).order("created_at", { ascending: false }).limit(100),
      accountScope ? Promise.resolve({ data: null, error: null }) : optionalMetric(
        () => serviceClient().rpc("intelligence_health"), { data: null, error: { message: "metrics_unavailable" } }),
      accountScope ? Promise.resolve(null) : optionalMetric(() => readJevCostMetrics(), { available: false } as const),
    ]);
    if (views.error) fail("views", views.error);
    const activityAvailable = !accountScope && !status.error && !!status.data;
    const processingEnabled = !intelligenceEnabled() ? false : status.error ? null : status.data?.enabled === true;
    const summary = { ...empty, ...(status.error ? {} : status.data),
      enabled: processingEnabled === true, processingEnabled, activityAvailable,
      health: health.error ? null : health.data, ...(jevCost ? { jevCost } : {}) };
    if (viewId) {
      let matchesQuery = db.from("intelligence_account_question_matches")
        .select("view_id,company_id,probability,result,evaluated_at,companies!inner(name,status)")
        .eq("view_id", viewId).neq("companies.status", "removed_from_tam")
        .order("probability", { ascending: false }).order("company_id").range(offset, offset + 49);
      if (companyId) matchesQuery = matchesQuery.eq("company_id", companyId);
      const [matches, queue] = await Promise.all([matchesQuery, optionalMetric(() => serviceClient().from("intelligence_account_question_jobs")
        .select("status", { count: "exact", head: true }).eq("view_id", viewId).in("status", ["queued", "running"]),
        { count: null, error: { message: "metrics_unavailable" } })]);
      if (matches.error) fail("observations", matches.error);
      return NextResponse.json({ ...summary,
        views: views.data ?? [], observations: [], accountMatches: (matches.data ?? []).map(row => ({ ...row,
          company_name: (row.companies as unknown as {name:string})?.name ?? "Unknown account", companies: undefined })),
        accountQuestionPending: queue.error ? null : queue.count ?? 0, hasMore: (matches.data?.length ?? 0) === 50 });
    }
    stage = "observations";
    let query = db.from("intelligence_observations")
      .select(`id,company_id,source_kind,source_url,title,event_date,observed_at,attributes,feedback_excluded,public_priority_weight,companies:companies!intelligence_observations_company_id_fkey!inner(name,status)${viewId ? ",intelligence_view_matches:intelligence_view_matches!intelligence_view_matches_observation_id_fkey!inner(probability,view_id)" : ""}`)
      .eq("is_current", true).eq("feedback_excluded", dismissed).neq("companies.status", "removed_from_tam")
      .order("observed_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
    if (companyId) query = query.eq("company_id", companyId);
    if (viewId) query = query.eq("intelligence_view_matches.view_id", viewId).gte("intelligence_view_matches.probability", 0.7);
    const { data, error } = await query;
    if (error) fail("observations", error);
    // The optional embedded relation makes this select dynamic to Supabase's parser.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const ids = rows.map((row) => String(row.id));
    stage = "feedback";
    const feedback = ids.length ? await db.from("intelligence_feedback").select("observation_id,reason,note").in("observation_id", ids) : { data: [], error: null };
    if (feedback.error) fail("feedback", feedback.error);
    stage = "response";
    const feedbackById = new Map((feedback.data ?? []).map((f) => [f.observation_id, { reason: f.reason, note: f.note }]));
    // Supabase's inferred relationship shape is unavailable until generated schema types are introduced.
    const observations = rows.map((row) => {
      const account = row.companies as { name?: string } | { name?: string }[];
      const matches = row.intelligence_view_matches as { probability: number }[] | undefined;
      const { companies: _companies, intelligence_view_matches: _matches, ...fields } = row;
      return { ...fields, company_name: (Array.isArray(account) ? account[0]?.name : account?.name) ?? "Unknown account",
        ...(matches?.length ? { matchProbability: matches[0].probability } : {}), feedback: feedbackById.get(String(row.id)) ?? null };
    });
    return NextResponse.json({ ...summary, views: views.data ?? [], observations, hasMore: observations.length === 50 });
  } catch {
    console.error("intelligence.read_failed", { stage, code });
    return NextResponse.json({ error: "intelligence_storage_unavailable", stage }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!sameOriginMutation(req)) return NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  if (!intelligenceEnabled()) return NextResponse.json({ error: "intelligence_disabled" }, { status: 409 });
  let body: Record<string, unknown>;
  try { body = await smallJson(req); } catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const db = serviceClient();
  try {
    if (body.action === "save_view") {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const question = typeof body.question === "string" ? body.question.trim() : "";
      if (!name || name.length > 120 || question.length < 8 || Buffer.byteLength(question) > 1200) return NextResponse.json({ error: "invalid_view" }, { status: 400 });
      const { data, error } = await db.from("intelligence_views").upsert({ name, question, active: true }, { onConflict: "question" }).select("id").single();
      if (error) throw new Error("view_save_failed");
      // The cron consumer remains the durable recovery path if this wakeup fails.
      after(async () => {
        await runIntelligenceWorker(1, Date.now() + 40_000).catch(() => {});
        await runAccountQuestionWorker(1, Date.now() + 120_000).catch(() => {});
      });
      return NextResponse.json({ ok: true, id: data.id });
    }
    if (body.action === "archive_view" && isUuid(body.viewId)) {
      const { error } = await db.from("intelligence_views").update({ active: false }).eq("id", body.viewId);
      if (error) throw new Error("view_archive_failed");
      return NextResponse.json({ ok: true });
    }
    if ((body.action === "feedback" || body.action === "clear_feedback") && isUuid(body.observationId)) {
      const reason = String(body.reason ?? "");
      if (body.action === "feedback" && !["useful", "wrong_company", "old_event", "irrelevant", "not_now"].includes(reason)) return NextResponse.json({ error: "invalid_feedback" }, { status: 400 });
      const note = typeof body.note === "string" ? body.note.trim().slice(0, 600) : "";
      const { data: observation, error: lookupError } = await db.from("intelligence_observations").select("company_id,title").eq("id", body.observationId).single();
      if (lookupError || !observation) return NextResponse.json({ error: "observation_not_found" }, { status: 404 });
      const { error } = body.action === "clear_feedback"
        ? await db.from("intelligence_feedback").delete().eq("company_id", observation.company_id).eq("observation_id", body.observationId)
        : await db.from("intelligence_feedback").upsert({
        company_id: observation.company_id, observation_id: body.observationId, reason,
        note, updated_at: new Date().toISOString(),
      }, { onConflict: "company_id,observation_id" });
      if (error) throw new Error("feedback_save_failed");
      // Corrections are already atomic in storage; priority recomputation can
      // recover on the existing recompute cron if its independent write fails.
      let priorityUpdated = true;
      try { await recomputePriority(observation.company_id); } catch { priorityUpdated = false; }
      return NextResponse.json({ ok: true, priorityUpdated });
    }
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "intelligence_write_failed" }, { status: 503 });
  }
}
