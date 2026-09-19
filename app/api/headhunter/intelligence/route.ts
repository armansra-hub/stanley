import { NextRequest, NextResponse, after } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { intelligenceUiAuthorized, isUuid, sameOriginMutation, smallJson } from "@/lib/intelligence/http";
import { runIntelligenceWorker } from "@/lib/intelligence/worker";
import { recomputePriority } from "@/lib/db/triggers";

export const dynamic = "force-dynamic";
export const maxDuration = 300;
const empty = { enabled: false, views: [], observations: [], hasMore: false,
  spend: { usedUsd: 0, reservedUsd: 0, limitUsd: 20 }, jobs: { queued: 0, running: 0, failed: 0 },
  sourceCoverage: { complete: 0, partial: 0, failed: 0 } };

export async function GET(req: NextRequest) {
  if (!intelligenceUiAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!intelligenceEnabled()) return NextResponse.json(empty);
  const params = req.nextUrl.searchParams;
  const companyId = params.get("companyId"), viewId = params.get("viewId");
  const dismissed = params.get("dismissed") === "true";
  const offset = Number(params.get("offset") ?? 0);
  if ((companyId && !isUuid(companyId)) || (viewId && !isUuid(viewId)) || !Number.isInteger(offset) || offset < 0 || offset > 100_000) {
    return NextResponse.json({ error: "invalid_filter" }, { status: 400 });
  }
  try {
    const db = serviceClient();
    const [status, views] = await Promise.all([
      db.rpc("intelligence_status"),
      db.from("intelligence_views").select("id,name,question,active,backfill_complete").eq("active", true).order("created_at", { ascending: false }).limit(100),
    ]);
    if (status.error || views.error) throw new Error("storage_unavailable");
    let query = db.from("intelligence_observations")
      .select(`id,company_id,source_kind,source_url,title,event_date,observed_at,attributes,feedback_excluded,public_priority_weight,companies!inner(name,status)${viewId ? ",intelligence_view_matches!inner(probability,view_id)" : ""}`)
      .eq("is_current", true).eq("feedback_excluded", dismissed).neq("companies.status", "removed_from_tam")
      .order("observed_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 49);
    if (companyId) query = query.eq("company_id", companyId);
    if (viewId) query = query.eq("intelligence_view_matches.view_id", viewId).gte("intelligence_view_matches.probability", 0.7);
    const { data, error } = await query;
    if (error) throw new Error("observations_unavailable");
    // The optional embedded relation makes this select dynamic to Supabase's parser.
    const rows = (data ?? []) as unknown as Record<string, unknown>[];
    const ids = rows.map((row) => String(row.id));
    const feedback = ids.length ? await db.from("intelligence_feedback").select("observation_id,reason,note").in("observation_id", ids) : { data: [], error: null };
    if (feedback.error) throw new Error("feedback_unavailable");
    const feedbackById = new Map((feedback.data ?? []).map((f) => [f.observation_id, { reason: f.reason, note: f.note }]));
    // Supabase's inferred relationship shape is unavailable until generated schema types are introduced.
    const observations = rows.map((row) => {
      const account = row.companies as { name?: string } | { name?: string }[];
      const matches = row.intelligence_view_matches as { probability: number }[] | undefined;
      const { companies: _companies, intelligence_view_matches: _matches, ...fields } = row;
      return { ...fields, company_name: (Array.isArray(account) ? account[0]?.name : account?.name) ?? "Unknown account",
        ...(matches?.length ? { matchProbability: matches[0].probability } : {}), feedback: feedbackById.get(String(row.id)) ?? null };
    });
    return NextResponse.json({ ...status.data, enabled: intelligenceEnabled() && status.data?.enabled === true, views: views.data ?? [], observations, hasMore: observations.length === 50 });
  } catch {
    return NextResponse.json({ error: "intelligence_storage_unavailable" }, { status: 503 });
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
      after(async () => { await runIntelligenceWorker(3, Date.now() + 120_000).catch(() => {}); });
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
