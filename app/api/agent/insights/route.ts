import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { TRIGGER_SPEC } from "@/lib/triggers/config";

/**
 * Findings from the LinkedIn/website FULL-TEXT reading pass (2026-07-30).
 *
 * Arman's rule: no finding without a verbatim quote. A reading agent reads a lead's
 * entire LinkedIn description, every company post, and every decision-maker post —
 * never keyword-matched — and reports what it found. This endpoint is the only way
 * those findings reach Stanley, and it enforces the rule structurally: `evidence`
 * (a real quote) is required on every row, or the whole batch is rejected.
 *
 * Two kinds of finding, two different fates:
 *   trigger      — a dated event (hiring, expansion, launch). The reading agent
 *                  already resolved company attribution unambiguously (it read THIS
 *                  company's own page), unlike the news-headline queue, so it writes
 *                  straight to `triggers` and feeds priority like any other signal.
 *   netsuite_fit /
 *   ops_profile  — a standing operating-model characteristic. Tag only, per Arman's
 *                  explicit call: never reorders the Triggered tab. Written to
 *                  lead_insights and rendered as a badge everywhere the lead appears.
 *
 * POST { agent, findings: [{ internalId, kind, label, detail?, evidence, sourceUrl?, confidence?, postedAt? }] }
 * sourceUrl should always be the LinkedIn post/page URL the finding was read from — it's
 * what the badge/trigger's "View source" link points at on the lead record.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_FINDINGS = 300;
const KINDS = new Set(["trigger", "netsuite_fit", "ops_profile"]);

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: { agent?: unknown; findings?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.findings) || !body.findings.length) {
    return NextResponse.json({ error: "findings must be a non-empty array" }, { status: 400 });
  }
  if (body.findings.length > MAX_FINDINGS) {
    return NextResponse.json({ error: `findings capped at ${MAX_FINDINGS} per request` }, { status: 400 });
  }

  const agent = callerAgent(req, body.agent);
  const dryRun = body.dryRun === true;
  const errors: { index: number; problem: string }[] = [];
  const rows: Record<string, unknown>[] = [];
  const triggerRows: { internalId: string; type: string; label: string; evidence: string; sourceUrl?: string; postedAt?: string }[] = [];

  (body.findings as Record<string, unknown>[]).forEach((f, i) => {
    const internalId = String(f.internalId ?? "").trim().replace(/\.0$/, "");
    const kind = String(f.kind ?? "").trim();
    const label = String(f.label ?? "").trim();
    const evidence = String(f.evidence ?? "").trim();
    if (!internalId || !/^\d+$/.test(internalId)) return void errors.push({ index: i, problem: "missing/invalid internalId" });
    if (!KINDS.has(kind)) return void errors.push({ index: i, problem: `kind must be one of ${[...KINDS].join(", ")}` });
    if (!label) return void errors.push({ index: i, problem: "label is required" });
    // The whole point of this endpoint: no quote, no finding.
    if (evidence.length < 10) return void errors.push({ index: i, problem: "evidence must be a real verbatim quote (>=10 chars) — no finding without a quote" });

    if (kind === "trigger") {
      // The reading agent classifies the event (finance_hire/new_entity/ma/press/…) —
      // falls back to "news" (the generic/lowest-weight type) rather than silently
      // mislabeling an expansion or launch as a finance hire.
      const type = String(f.type ?? "").trim();
      if (!(type in TRIGGER_SPEC)) return void errors.push({ index: i, problem: `trigger kind requires a valid type (one of ${Object.keys(TRIGGER_SPEC).join(", ")})`, });
      triggerRows.push({ internalId, type, label, evidence, sourceUrl: f.sourceUrl ? String(f.sourceUrl) : undefined, postedAt: f.postedAt ? String(f.postedAt) : undefined });
    } else {
      rows.push({
        netsuite_internal_id: internalId, source: "linkedin", kind, label,
        detail: f.detail ? String(f.detail).slice(0, 500) : null,
        evidence: evidence.slice(0, 600),
        evidence_url: f.sourceUrl ? String(f.sourceUrl) : null,
        confidence: ["high", "medium", "low"].includes(String(f.confidence)) ? f.confidence : "medium",
        posted_at: f.postedAt ? String(f.postedAt).slice(0, 10) : null,
      });
    }
  });

  if (!rows.length && !triggerRows.length) {
    return NextResponse.json({ error: "no usable findings", errors }, { status: 422 });
  }

  const db = serviceClient();
  const allIds = [...new Set([...rows.map((r) => String(r.netsuite_internal_id)), ...triggerRows.map((t) => t.internalId)])];
  const { data: companies, error: lookupErr } = await db.from("companies").select("id, netsuite_internal_id").in("netsuite_internal_id", allIds);
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  const byNsid = new Map((companies ?? []).map((c) => [String(c.netsuite_internal_id), String(c.id)]));
  const missing = allIds.filter((id) => !byNsid.has(id));

  if (dryRun) {
    return NextResponse.json({
      dryRun: true, wouldWriteInsights: rows.filter((r) => byNsid.has(String(r.netsuite_internal_id))).length,
      wouldWriteTriggers: triggerRows.filter((t) => byNsid.has(t.internalId)).length,
      missingInternalIds: missing, errorCount: errors.length, rowErrors: errors.slice(0, 30),
    });
  }

  for (const r of rows) {
    const cid = byNsid.get(String(r.netsuite_internal_id));
    if (cid) r.company_id = cid;
  }
  const insightRows = rows.filter((r) => r.company_id);
  if (insightRows.length) {
    for (let i = 0; i < insightRows.length; i += 200) {
      const { error } = await db.from("lead_insights").upsert(insightRows.slice(i, i + 200), {
        onConflict: "company_id,source,kind,label", ignoreDuplicates: false,
      });
      if (error) return NextResponse.json({ error: error.message, writtenBefore: i }, { status: 500 });
    }
  }

  let triggersWritten = 0;
  for (const t of triggerRows) {
    const cid = byNsid.get(t.internalId);
    if (!cid) continue;
    const ok = await recordTrigger(cid, {
      type: t.type,
      summary: `LinkedIn: ${t.label} — “${t.evidence.slice(0, 150)}”`,
      source_name: "LinkedIn", source_url: t.sourceUrl ?? null, signal_date: t.postedAt ?? null,
    });
    if (ok) { triggersWritten++; await recomputePriority(cid); }
  }

  await logEvent("headhunter", "linkedin.insights_recorded", {
    summary: `${agent} recorded ${insightRows.length} LinkedIn insights + ${triggersWritten} triggers (${errors.length} bad rows, ${missing.length} unmatched)`,
    entity_type: "agent_bridge", meta: { agent, insights: insightRows.length, triggers: triggersWritten, errors: errors.length, missing: missing.length },
  });

  return NextResponse.json({
    insightsWritten: insightRows.length, triggersWritten, missingInternalIds: missing.slice(0, 30),
    missingCount: missing.length, errorCount: errors.length, rowErrors: errors.slice(0, 30),
  });
}

/** GET ?internalId=123 — a lead's recorded insights, for review or re-reading decisions. */
export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const internalId = new URL(req.url).searchParams.get("internalId");
  if (!internalId) return NextResponse.json({ error: "internalId is required" }, { status: 400 });
  const { data, error } = await serviceClient().from("lead_insights").select("*").eq("netsuite_internal_id", internalId).order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ internalId, count: data?.length ?? 0, insights: data ?? [] });
}
