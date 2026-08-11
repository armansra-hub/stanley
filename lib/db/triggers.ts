import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { getPublicGrowthDetail, type PublicGrowthDetail } from "@/lib/publicGrowth/detail";
import { TRIGGER_SPEC, decayFactor } from "@/lib/triggers/config";
import { mapSignal, withTriggers, withInsights, type InsightBadge } from "@/lib/db/companies";
import type { Company } from "@/lib/types";
import { scoreTalUrgency } from "@/lib/tal/urgency";
import {
  isFinanceHireEligible,
  isFinanceHireEvidenceUrl,
  isPublishableTriggerEvidence,
  isPublishableTriggerForCompany,
  type TriggerEvidence,
} from "@/lib/triggers/signalIntegrity";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TriggerInput { type: string; summary: string; source_name?: string; source_url?: string | null; signal_date?: string | null }
export interface TriggerRow { id: string; company_id: string; type: string; strength: number; half_life_days: number; summary: string; source_name: string | null; source_url: string | null; signal_date: string | null; detected_at: string; metadata?: Record<string, unknown> | null }

/** Homepage growth phrases were historically stored with a fabricated /# anchor.
 * Preserve those rows for auditability, but never score or display them as events.
 * A real M&A/expansion trigger must link to an actual article or evidence page. */
export function isPublishableTrigger(t: TriggerEvidence): boolean {
  return isPublishableTriggerEvidence(t);
}

/** Insert a trigger (deduped by company + source_url). Returns true if a NEW one landed.
 * Human review is durable: reviewed and dismissed leads stay hidden even when a new
 * public signal lands. Only exported leads may re-enter after the 14-day grace. */
export async function recordTrigger(companyId: string, t: TriggerInput): Promise<boolean> {
  const spec = TRIGGER_SPEC[t.type] ?? TRIGGER_SPEC.news;
  const db = serviceClient();
  // Defensive storage gate: call sites also filter to avoid wasted source work, but
  // every writer (including agent-insight promotion) ultimately passes through here.
  if (!isPublishableTriggerEvidence(t)) return false;
  if (t.type === "finance_hire") {
    if (!isFinanceHireEvidenceUrl(t.source_url, t.source_name)) return false;
    const { data: company, error: companyError } = await db.from("companies")
      .select("name, record_dead, description, subindustry, ns_industry")
      .eq("id", companyId)
      .maybeSingle();
    if (companyError || !company || !isFinanceHireEligible(company)) return false;
  }
  const { error } = await db.from("triggers").insert({
    company_id: companyId, type: t.type, strength: spec.strength, half_life_days: spec.half_life_days,
    summary: t.summary.slice(0, 280), source_name: t.source_name ?? null, source_url: t.source_url ?? null, signal_date: t.signal_date ?? null,
  });
  if (error) return false; // unique-index violation on a dupe
  try {
    const { data: c } = await db.from("companies").select("status, exported_at").eq("id", companyId).maybeSingle();
    const s = (c as any)?.status as string | undefined;
    // Human review is durable. New signals may resurface exported leads after the
    // grace period, but must never reopen reviewed or dismissed accounts.
    if (s === "exported_csv" || s === "exported_sql") {
      const exp = (c as any)?.exported_at ? new Date((c as any).exported_at).getTime() : 0;
      if (Date.now() - exp > 14 * 86_400_000) {
        await db.from("companies").update({ status: "new", has_new_signal: true }).eq("id", companyId);
      }
    }
  } catch { /* resurfacing is best-effort */ }
  return true;
}

/**
 * Recompute + cache a company's ERP-READINESS score (stored in `priority`), so the
 * Triggered worklist ranks by likelihood-to-buy, not just newest event:
 *   strongest active (decayed) trigger
 *   × fit_weight × multi-list bonus
 *   × multi-signal bonus  (more DISTINCT active trigger types = riper; +15%/extra type)
 *   × incumbent factor    (QuickBooks/no-ERP → ×1.25 ready; already on NetSuite/Intacct → 0)
 *   × PE factor           (PE/portfolio-owned → ×1.2, standardizes on ERP)
 *   × VERDICT factor      (what a human heard from the prospect outranks any signal)
 *
 * On the verdict factor (Arman, 2026-07-28): the best information about a lead is
 * what they told us with their own mouth, and the grader read those notes. Before
 * this, priority was pure signal strength, so leads a human had graded 0 sat at the
 * top of the worklist on the strength of a UCC filing — Kompass Kapital (graded 0)
 * at priority 129, ps Hummingbird (graded 8) at 132. A scraped event should reorder
 * leads worth working; it should never promote one a human already closed out.
 */
export async function recomputePriority(companyId: string): Promise<number> {
  const db = serviceClient();
  // select * so optional ERP-readiness columns (migration 0020) are included when present.
  const { data: c, error: companyError } = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
  if (companyError) throw new Error(`priority company read failed: ${companyError.message}`);
  if (!c) throw new Error(`priority company not found: ${companyId}`);
  const { data: trigs, error: triggerError } = await db.from("triggers")
    .select("type, strength, half_life_days, signal_date, detected_at, summary, source_name, source_url, metadata")
    .eq("company_id", companyId);
  if (triggerError) throw new Error(`priority trigger read failed: ${triggerError.message}`);
  const fit = Number((c as any)?.fit_weight ?? 1);
  const listBonus = 1 + 0.1 * Math.max(0, ((c as any)?.lists?.length ?? 1) - 1);
  let best = 0;
  const activeTypes = new Set<string>();
  for (const t of ((trigs ?? []) as any[]).filter((trigger) => isPublishableTriggerForCompany(trigger, c as any))) {
    const decay = decayFactor(t.signal_date, t.detected_at, t.half_life_days);
    const v = Number(t.strength) * decay;
    if (v > best) best = v;
    if (decay > 0.25) activeTypes.add(String(t.type)); // still meaningfully active
  }
  // DOL 5500 headcount growth ≥25% acts as a standing (synthetic) signal so high-growth
  // claimable leads rank even with no current news trigger. Scales 25%→~60, 100%+→~95.
  const hcPct = Number((c as any)?.headcount_growth_pct ?? 0);
  if (hcPct >= 25) { best = Math.max(best, Math.min(95, 55 + (hcPct - 25) * 0.5)); activeTypes.add("headcount_growth"); }
  const multiBonus = 1 + 0.15 * Math.max(0, activeTypes.size - 1);
  const incumbent = ((c as any)?.erp_incumbent as string | null) ?? null;
  const incumbentFactor = incumbent === "erp" || incumbent === "netsuite" || incumbent === "intacct"
    ? 0 // already on an ERP → not a prospect
    : incumbent === "quickbooks" ? 1.25 : 1;
  const peFactor = (c as any)?.pe_owned ? 1.2 : 1;
  // Record says DEAD (explicit rejection / hard disqualify in the NetSuite record) →
  // crush priority so they sink to the bottom EVERYWHERE, but stay visible (⛔ badge).
  const deadFactor = (c as any)?.record_dead ? 0.1 : 1;
  // The Triggered tab is an EVENT list — its job is "something happened here today",
  // so a low grade must NOT be damped: a lead graded 8 with fresh funding is exactly
  // what belongs at the top. Only a closed-out lead is damped, because an event does
  // not make a company worth calling after they have told us no.
  //
  // This affects only the event worklist. The retired outside-signal score layer
  // must never feed this priority back into TAM or Old Gold.
  const graded = (c as any)?.tam_score;
  const digest = String((c as any)?.record_digest ?? "").toLowerCase();
  let verdictFactor = 1;
  if (graded !== null && graded !== undefined && Number(graded) <= 0) verdictFactor = 0.1;
  else if (digest.includes("points to disqualification")) verdictFactor = 0.35;
  else if (digest.includes("some historical fit or pain exists")) verdictFactor = 0.85;
  const priority = Math.round(best * fit * listBonus * multiBonus * incumbentFactor * peFactor * deadFactor * verdictFactor * 100) / 100;
  const { error: updateError } = await db.from("companies").update({ priority }).eq("id", companyId);
  if (updateError) throw new Error(`priority update failed: ${updateError.message}`);
  return priority;
}

/** Clear only the cached trigger alert in one company-row-locked transaction
 * when no unquarantined trigger remains. `has_new_signal` belongs to the separate
 * signals table and is deliberately outside this repair. */
export async function reconcilePublishableSignalFlags(companyId: string): Promise<boolean> {
  const { data, error } = await serviceClient().rpc("reconcile_company_signal_flags", {
    p_company_id: companyId,
  });
  if (error) throw new Error(`signal-flag reconciliation failed: ${error.message}`);
  const readback = data as {
    cleared?: unknown;
    tal_alert?: unknown;
    unquarantined_triggers?: unknown;
  } | null;
  if (!readback) throw new Error(`signal-flag company not found: ${companyId}`);
  if (readback.cleared === true && readback.tal_alert !== false) {
    throw new Error(`signal-flag readback mismatch: ${companyId}`);
  }
  if (readback.cleared !== true && readback.cleared !== false) {
    throw new Error(`signal-flag receipt invalid: ${companyId}`);
  }
  return readback.cleared;
}

/**
 * Queue a headline-derived signal for verification instead of publishing it.
 *
 * Attributing a headline to a company by name is unreliable for the 40% of the TAM
 * whose name is one ordinary word (Access, Weekday, Aerofly, Encore, Circle). Rather
 * than guess, candidates land in trigger_candidates and Claude Code reads each one
 * locally before it can become a trigger — so nothing unverified reaches the tab.
 * Idempotent on (company_id, type, summary): re-running a sweep won't pile up dupes.
 */
export async function queueCandidate(
  company: { id: string; name: string; netsuite_internal_id?: string | null; record_dead?: boolean | null; description?: string | null; subindustry?: string | null; ns_industry?: string | null },
  t: { type: string; summary: string; source_name?: string | null; source_url?: string | null; signal_date?: string | null },
): Promise<boolean> {
  try {
    if (t.type === "finance_hire" && (!isFinanceHireEligible(company) || !isFinanceHireEvidenceUrl(t.source_url, t.source_name))) return false;
    const spec = TRIGGER_SPEC[t.type as keyof typeof TRIGGER_SPEC] as { strength?: number; half_life_days?: number } | undefined;
    const { data, error } = await serviceClient().from("trigger_candidates").upsert({
      company_id: company.id,
      netsuite_internal_id: company.netsuite_internal_id ?? null,
      company_name: company.name,
      type: t.type,
      summary: t.summary,
      source_name: t.source_name ?? null,
      source_url: t.source_url ?? null,
      signal_date: t.signal_date ?? null,
      strength: spec?.strength ?? null,
      half_life_days: spec?.half_life_days ?? null,
    }, { onConflict: "company_id,type,summary", ignoreDuplicates: true }).select("id");
    return !error && (data?.length ?? 0) === 1;
  } catch {
    return false; // never break a sweep over the queue
  }
}

/** Avoid paying to classify a headline that this company has already reviewed or
 * queued. The exact insert remains the concurrency-safe dedupe gate; this read is
 * an inexpensive fast path for the common repeat-news case. */
export async function headlineCandidateSeen(companyId: string, summary: string): Promise<boolean> {
  try {
    const { data, error } = await serviceClient().from("trigger_candidates")
      .select("id")
      .eq("company_id", companyId)
      .eq("summary", summary)
      .limit(1);
    return !error && (data?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/** Publish a verified candidate as a real trigger. */
export async function promoteCandidate(candidateId: string): Promise<boolean> {
  const db = serviceClient();
  const { data: c } = await db.from("trigger_candidates").select("*").eq("id", candidateId).maybeSingle();
  if (!c || c.verdict !== "keep" || c.promoted_trigger_id) return false;
  const ok = await recordTrigger(String(c.company_id), {
    type: String(c.type), summary: String(c.summary),
    source_name: (c.source_name as string) ?? null, source_url: (c.source_url as string) ?? null,
    signal_date: (c.signal_date as string) ?? null,
  });
  if (ok) {
    const { data: t } = await db.from("triggers").select("id").eq("company_id", c.company_id)
      .eq("type", c.type).order("detected_at", { ascending: false }).limit(1).maybeSingle();
    await db.from("trigger_candidates").update({ promoted_trigger_id: t?.id ?? null }).eq("id", candidateId);
    await recomputePriority(String(c.company_id));
  }
  return ok;
}

/** Set ERP-readiness flags on a company (graceful no-op before migration 0020). */
export async function setErpFlags(companyId: string, flags: { pe_owned?: boolean; erp_incumbent?: string | null }): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update(flags).eq("id", companyId);
  } catch { /* columns missing pre-0020 → no-op */ }
}

/** The next batch of base companies to sweep — never-checked first, then oldest.
 * The default path atomically reserves work. A positive `offset` is retained only
 * for bounded manual recovery; mutable-cursor offset pages must never run in parallel. */
export interface RotationSignalContext {
  record_dead: boolean;
  description: string | null;
  subindustry: string | null;
  ns_industry: string | null;
}

/** All default cron waves in one UTC day share this immutable reservation cutoff. */
export function utcDailyRotationEpoch(now = new Date()): string {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("rotation epoch requires a valid date");
  return new Date(Math.floor(timestamp / 86_400_000) * 86_400_000).toISOString();
}

async function reserveRotation<T>(source: string, limit: number, scope: string | null = null): Promise<T[]> {
  const { data, error } = await serviceClient().rpc("reserve_company_rotation", {
    p_source: source,
    p_limit: limit,
    p_scope: scope,
    p_epoch: utcDailyRotationEpoch(),
  });
  if (error) throw new Error(`${source} rotation reservation failed: ${error.message}`);
  return (data ?? []) as T[];
}

export interface PriorityRecomputeReservation {
  company_id: string;
  reservation_kind: "ghost" | "zombie";
}

/** Reserve one immediately attempted recompute micro-batch without ordering by priority. */
export async function reservePriorityRecompute(
  limit: number,
  zombieSlots: number,
  epoch = utcDailyRotationEpoch(),
): Promise<PriorityRecomputeReservation[]> {
  const { data, error } = await serviceClient().rpc("reserve_priority_recompute", {
    p_epoch: epoch,
    p_limit: limit,
    p_zombie_slots: zombieSlots,
  });
  if (error) throw new Error(`priority recompute reservation failed: ${error.message}`);
  return (data ?? []) as PriorityRecomputeReservation[];
}

export async function pickForRotation(limit: number, offset = 0): Promise<Array<{ id: string; name: string; domain: string | null; claimable: boolean } & RotationSignalContext>> {
  if (offset === 0) return reserveRotation("trigger", limit);
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name, domain, claimable, record_dead, description, subindustry, ns_industry")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

export async function markChecked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = serviceClient();
  await db.from("companies").update({ last_checked_at: new Date().toISOString() }).in("id", ids);
}

/** The next batch of base companies to ATS-check — must have a domain; longest-since
 * (or never) ats-checked first. Positive offsets are manual recovery only. */
export async function pickAtsForRotation(limit: number, offset = 0): Promise<Array<{ id: string; name: string; domain: string; ats_type: string | null; ats_token: string | null } & RotationSignalContext>> {
  if (offset === 0) return reserveRotation("ats", limit);
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name, domain, ats_type, ats_token, record_dead, description, subindustry, ns_industry")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .not("domain", "is", null)
    .order("ats_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

/** Record the ATS detection/poll outcome (stamps ats_checked_at). Graceful pre-0020. */
export async function setAtsChecked(id: string, patch: { ats_type?: string; ats_token?: string | null }): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update({ ...patch, ats_checked_at: new Date().toISOString() }).eq("id", id);
  } catch { /* columns missing pre-0020 → no-op */ }
}

/** Rotation for the slow structured-signal sweep (USAspending; name-only Form D
 * is retired until a second identity corroborates it), on its own cursor
 * (signals_checked_at, migration 0021) so it doesn't fight the news sweep.
 * NetSuite-TAM first; never/longest-checked first. Positive offsets are manual only. */
export async function pickSignalsForRotation(limit: number, offset = 0): Promise<{ id: string; name: string }[]> {
  if (offset === 0) return reserveRotation("signals", limit);
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .order("signals_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

export async function markSignalsChecked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = serviceClient();
    await db.from("companies").update({ signals_checked_at: new Date().toISOString() }).in("id", ids);
  } catch { /* column missing pre-0021 → no-op */ }
}

/** All TAL (claimed) companies, for the daily highest-priority news sweep. */
export async function listTalCompanies(): Promise<Array<{ id: string; name: string } & RotationSignalContext>> {
  const db = serviceClient();
  const out: Array<{ id: string; name: string } & RotationSignalContext> = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("id, name, record_dead, description, subindustry, ns_industry").eq("tal_claimed", true).range(from, from + 999);
    const batch = (data ?? []) as Array<{ id: string; name: string } & RotationSignalContext>;
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

/** Raise the in-app alert flag on TAL leads that just got a new signal. */
export async function setTalAlert(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = serviceClient();
    for (let i = 0; i < ids.length; i += 200) {
      await db.from("companies").update({ tal_alert: true }).in("id", ids.slice(i, i + 200));
    }
  } catch { /* column missing pre-0025 → no-op */ }
}

/** Clear TAL alerts (specific ids, or all when ids omitted) once the AE has seen them. */
export async function clearTalAlert(ids?: string[]): Promise<void> {
  try {
    const db = serviceClient();
    if (ids && ids.length) {
      for (let i = 0; i < ids.length; i += 200) await db.from("companies").update({ tal_alert: false }).in("id", ids.slice(i, i + 200));
    } else {
      await db.from("companies").update({ tal_alert: false }).eq("tal_alert", true);
    }
  } catch { /* no-op */ }
}

/** TAL leads currently flagged with a new signal (for the in-app notification panel),
 * ranked by priority, with their top trigger. */
export async function listTalAlerts(): Promise<TriggeredCompany[]> {
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("*, triggers(*)").eq("tal_alert", true)
    .order("priority", { ascending: false }).order("name", { ascending: true }).limit(200);
  if (error) return [];
  return (data ?? []).map((r: any) => {
    const trigs = ((r.triggers ?? []) as TriggerRow[]).filter((trigger) => isPublishableTriggerForCompany(trigger, r));
    const rankedTriggers = trigs.map((t) => ({ t, v: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) })).sort((a, b) => b.v - a.v);
    const top = rankedTriggers[0]?.t;
    const { triggers, ...rest } = r; void triggers;
    return { ...mapBasic(rest), priority: r.priority != null ? Number(r.priority) : 0, top_trigger: top ? { type: top.type, summary: top.summary, signal_date: top.signal_date, detected_at: top.detected_at } : null } as TriggeredCompany;
  });
}

/** Claimable leads with a domain, for the website-change watch. Ordered by
 * site_checked_at (never/longest first). Its own cursor.
 * scope: "claimable" = NetSuite TAM (the priority set, refreshed fastest);
 *        "tail" = the monitored non-claimable base (ZoomInfo-only leads) — the AE
 *        mainly works claimable but still wants the ZoomInfo TAM watched. */
export async function pickSitesForRotation(limit: number, offset = 0, scope: "claimable" | "tail" = "claimable"): Promise<Array<{ id: string; name: string; domain: string; site_hash: string | null; site_checked_at: string | null } & RotationSignalContext>> {
  if (offset === 0) return reserveRotation("site", limit, scope);
  const db = serviceClient();
  const base: any = db.from("companies").select("id, name, domain, site_hash, site_checked_at, record_dead, description, subindustry, ns_industry")
    .neq("status", "removed_from_tam")
    .not("domain", "is", null);
  const scoped = scope === "claimable"
    ? base.contains("lists", ["netsuite_tam"])
    : base.eq("is_base", true).not("claimable", "is", true);
  const { data } = await scoped
    .order("site_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

/** Flag a detected parent company (subsidiary). Graceful pre-0029. */
export async function setParent(id: string, name: string, confidence: "high" | "low"): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update({ has_parent: true, parent_name: name, parent_confidence: confidence }).eq("id", id);
  } catch { /* columns missing pre-0029 → no-op */ }
}

/** Store the latest website growth-phrase fingerprint + stamp the check time. */
export async function setSiteChecked(id: string, hash: string): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update({ site_hash: hash, site_checked_at: new Date().toISOString() }).eq("id", id);
  } catch { /* columns missing pre-0027 → no-op */ }
}

/** Stamp a failed website attempt without replacing its last known fingerprint. */
export async function markSiteAttempted(id: string): Promise<void> {
  const { error } = await serviceClient().from("companies")
    .update({ site_checked_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`website rotation checkpoint failed: ${error.message}`);
}

/** TAM carriers for the FMCSA fleet-growth monitor, oldest FMCSA check first. */
export async function pickCarriersForRotation(limit: number, offset = 0): Promise<{ id: string; name: string }[]> {
  if (offset === 0) return reserveRotation("fmcsa", limit);
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("id, name")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .or("subindustry.ilike.*truck*,subindustry.ilike.*transport*,subindustry.ilike.*logistic*,subindustry.ilike.*freight*,subindustry.ilike.*carrier*,subindustry.ilike.*warehous*,subindustry.ilike.*moving*,subindustry.ilike.*hauling*")
    .order("fmcsa_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`FMCSA rotation load failed: ${error.message}`);
  return (data ?? []) as any[];
}

export async function markFmcsaChecked(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await serviceClient().from("companies")
    .update({ fmcsa_checked_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`FMCSA rotation checkpoint failed: ${error.message}`);
}

/** Base companies in a given state (for the state-registry watch: new entities + UCC).
 * Whole monitored base, claimable first — the AE watches the ZoomInfo tail too. */
export async function pickSosCompaniesForRotation(state: string, limit: number, offset = 0): Promise<{ id: string; name: string; city: string | null }[]> {
  if (offset === 0) return reserveRotation("sos", limit, state);
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("id, name, city")
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .eq("state", state)
    .order("sos_checked_at", { ascending: true, nullsFirst: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`SOS rotation load failed: ${error.message}`);
  return (data ?? []) as any[];
}

export async function markSosChecked(ids: string[]): Promise<void> {
  if (!ids.length) return;
  const { error } = await serviceClient().from("companies")
    .update({ sos_checked_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw new Error(`SOS rotation checkpoint failed: ${error.message}`);
}

/** Map a mapCompany-shaped row + attach the top trigger (for the Triggered worklist). */
export interface TriggerPreview { type: string; summary: string; source_name: string | null; source_url: string | null; signal_date: string | null; detected_at: string }
export interface TriggeredCompany extends Company { priority?: number; top_trigger?: TriggerPreview | null; all_triggers?: TriggerPreview[]; trigger_count?: number; trigger_types?: string[]; insights?: InsightBadge[] }

/** The synthetic "signal" for DOL-5500 headcount leads in the signal-type filter
 * (they surface via headcount_growth_pct, not a trigger row). */
export const HEADCOUNT_PSEUDO_TYPE = "headcount_growth";

/** Base companies with an active trigger (priority>0), ranked by cached priority, paginated.
 * Hidden leads (reviewed/dismissed/exported) are excluded unless includeHidden.
 * opts.types = signal-type filter (multi-select in the UI): keep only leads with at
 * least one trigger of a selected type (or ≥25% headcount when the pseudo-type is
 * selected). Filtering happens after the fetch — the active triggered set is a few
 * hundred rows, so we pull it whole and paginate in memory for correct totals. */
export async function listTriggered(opts: { limit?: number; offset?: number; includeHidden?: boolean; q?: string; state?: string; subindustry?: string; band?: string; claimable?: boolean; erp?: boolean; tags?: string[]; matchAll?: boolean; types?: string[]; signalMatchAll?: boolean; signalDateFrom?: string; signalDateTo?: string; minimumEmployees?: number; minimumParticipants?: number } = {}): Promise<{ companies: TriggeredCompany[]; total: number }> {
  const db = serviceClient();
  const typeFilter = (opts.types ?? []).filter(Boolean);
  const signalDateFrom = opts.signalDateFrom ? Date.parse(`${opts.signalDateFrom}T00:00:00.000Z`) : null;
  const signalDateTo = opts.signalDateTo ? Date.parse(`${opts.signalDateTo}T23:59:59.999Z`) : null;
  const hasEventFilters = typeFilter.length > 0 || signalDateFrom != null || signalDateTo != null || opts.minimumEmployees != null || opts.minimumParticipants != null;
  const limit = Math.min(opts.limit ?? 100, 1000), offset = opts.offset ?? 0;
  let q = db.from("companies").select("*, triggers(*), lead_insights(*)", { count: "exact" })
    .contains("lists", ["netsuite_tam"])
    .neq("status", "removed_from_tam")
    .or("priority.gt.0,headcount_growth_pct.gte.25"); // a news trigger OR a ≥25% DOL-5500 headcount signal
  if (!opts.includeHidden) q = q.not("status", "in", "(reviewed,dismissed,exported_csv,exported_sql)");
  // Same filter surface as Discovered / TAM Base.
  if (opts.state) q = q.eq("state", opts.state);
  if (opts.subindustry) q = q.eq("subindustry", opts.subindustry);
  if (opts.claimable) q = q.eq("claimable", true);
  if (opts.erp) q = q.eq("erp_ready", true);
  if (opts.tags?.length) q = opts.matchAll ? q.contains("lists", opts.tags) : q.overlaps("lists", opts.tags);
  if (opts.band === "Strong") q = q.gte("signal_score", 60);
  else if (opts.band === "Medium") q = q.gte("signal_score", 30).lt("signal_score", 60);
  else if (opts.band === "Weak") q = q.lt("signal_score", 30);
  if (opts.q) { const s = opts.q.replace(/[%,]/g, " ").trim(); if (s) q = q.or(`name.ilike.%${s}%,domain.ilike.%${s}%`); }
  // With a signal-type filter we fetch the whole matching set (bounded) and paginate
  // in memory, so totals stay correct after filtering. Without one: normal DB paging.
  const { data, count, error } = await q
    .order("record_dead", { ascending: true }) // dead sinks even when its cached priority is stale
    .order("priority", { ascending: false }).order("name", { ascending: true })
    .range(hasEventFilters ? 0 : offset, hasEventFilters ? 0 + 1999 : offset + limit - 1);
  if (error) throw new Error(`listTriggered failed: ${error.message}`);
  let companies = (data ?? []).map((r: any) => {
    const trigs = ((r.triggers ?? []) as TriggerRow[]).filter((trigger) => isPublishableTriggerForCompany(trigger, r));
    // ALL triggers, strongest (decayed) first — the row shows every one. When a
    // signal-type filter is active, matching types sort ahead of the rest so the
    // Why column leads with what you filtered for.
    const live = (t: TriggerRow) => t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days);
    const sorted = [...trigs].sort((a, b) => {
      if (typeFilter.length) {
        const am = typeFilter.includes(a.type) ? 0 : 1, bm = typeFilter.includes(b.type) ? 0 : 1;
        if (am !== bm) return am - bm;
      }
      return live(b) - live(a);
    });
    const all_triggers: TriggerPreview[] = sorted.map((t) => ({ type: t.type, summary: t.summary, source_name: t.source_name, source_url: t.source_url, signal_date: t.signal_date, detected_at: t.detected_at }));
    const { triggers, ...rest } = r; void triggers;
    const trigger_types = [...new Set(trigs.map((t) => t.type))];
    const { rest: rest2, insights } = withInsights(rest);
    return { ...mapBasic(rest2), priority: r.priority != null ? Number(r.priority) : 0, top_trigger: all_triggers[0] ?? null, all_triggers, trigger_count: trigs.length, trigger_types, insights } as TriggeredCompany;
  });
  if (hasEventFilters) {
    const inSignalDateRange = (t: TriggerPreview) => {
      const at = Date.parse(t.signal_date ?? t.detected_at);
      return Number.isFinite(at) && (signalDateFrom == null || at >= signalDateFrom) && (signalDateTo == null || at <= signalDateTo);
    };
    const dateIsActive = signalDateFrom != null || signalDateTo != null;
    const wantHeadcount = typeFilter.includes(HEADCOUNT_PSEUDO_TYPE);
    companies = companies.filter((c) => {
      if (opts.minimumEmployees != null && (c.employee_count ?? -1) < opts.minimumEmployees) return false;
      if (opts.minimumParticipants != null && (c.active_participant_count ?? -1) < opts.minimumParticipants) return false;

      const datedTriggers = (c.all_triggers ?? []).filter(inSignalDateRange);
      if (typeFilter.length) {
        const matchedTypes = new Set(datedTriggers.map((t) => t.type));
        const hasSyntheticHeadcount = wantHeadcount && !dateIsActive && (c.headcount_growth_pct ?? 0) >= 25;
        const matchesType = (type: string) => type === HEADCOUNT_PSEUDO_TYPE ? hasSyntheticHeadcount : matchedTypes.has(type);
        return opts.signalMatchAll ? typeFilter.every(matchesType) : typeFilter.some(matchesType);
      }
      // With no type selected, the date filter means “any signal happened in this range.”
      return !dateIsActive || datedTriggers.length > 0;
    });
    return { companies: companies.slice(offset, offset + limit), total: companies.length };
  }
  return { companies, total: count ?? 0 };
}

// Light mapper (mirrors mapCompany's relevant fields; triggers join handled above).
function mapBasic(r: any): Company {
  return {
    id: String(r.id), name: String(r.name), domain: r.domain ?? null, website_raw: r.website_raw ?? null,
    description: r.description ?? null, subindustry: r.subindustry ?? null, ns_industry: r.ns_industry ?? null,
    in_territory: Boolean(r.in_territory), territory_fit: r.territory_fit == null ? null : Number(r.territory_fit),
    source: r.source ?? "discovered", status: r.status ?? "new", state: r.state ?? null, city: r.city ?? null,
    employee_band: r.employee_band ?? null, revenue_band: r.revenue_band ?? null, signal_score: Number(r.signal_score ?? 0),
    score_tier: r.score_tier ?? null, score_reason: r.score_reason ?? null, has_new_signal: Boolean(r.has_new_signal),
    already_on_netsuite: Boolean(r.already_on_netsuite), starred: Boolean(r.starred), thumbs_down: Boolean(r.thumbs_down),
    rating: r.rating != null ? Number(r.rating) : null, rating_comment: r.rating_comment ?? null,
    sources: Array.isArray(r.sources) ? r.sources : [], notes: r.notes ?? null,
    first_seen_at: String(r.first_seen_at ?? ""), last_updated_at: String(r.last_updated_at ?? ""), exported_at: r.exported_at ?? null,
    is_base: Boolean(r.is_base), lead_vendor: r.lead_vendor ?? null, fit_weight: r.fit_weight != null ? Number(r.fit_weight) : 1,
    technologies: Array.isArray(r.technologies) ? r.technologies : [], erp_ready: Boolean(r.erp_ready),
    employee_count: r.employee_count != null ? Number(r.employee_count) : null,
    lists: Array.isArray(r.lists) ? r.lists : [], claimable: Boolean(r.claimable),
    netsuite_internal_id: r.netsuite_internal_id ?? null,
    erp_incumbent: r.erp_incumbent ?? null, pe_owned: Boolean(r.pe_owned),
    tal_claimed: Boolean(r.tal_claimed), tal_dq: Boolean(r.tal_dq), tal_alert: Boolean(r.tal_alert),
    claim_bullets: Array.isArray(r.claim_bullets) ? (r.claim_bullets as string[]) : null,
    headcount_growth_pct: r.headcount_growth_pct != null ? Number(r.headcount_growth_pct) : null,
    active_participant_count: r.active_participant_count != null ? Number(r.active_participant_count) : null,
    has_parent: Boolean(r.has_parent), parent_name: r.parent_name ?? null, parent_confidence: r.parent_confidence ?? null,
    // Old Gold intelligence — migration 0030 (graceful pre-migration)
    last_sql_date: r.last_sql_date ?? null, qual_note: r.qual_note ?? null,
    oldgold_score: r.oldgold_score != null ? Number(r.oldgold_score) : null,
    tam_score: r.tam_score != null ? Number(r.tam_score) : null,
    tam_provisional: Boolean(r.tam_provisional),
    oldgold_class: r.oldgold_class ?? null,
    oldgold_reasons: Array.isArray(r.oldgold_reasons) ? r.oldgold_reasons : null,
    record_digest: r.record_digest ?? null,
    record_dead: Boolean(r.record_dead), record_dead_reason: r.record_dead_reason ?? null,
    revisit_on: r.revisit_on ?? null,
    signals: [],
  };
}

/** Old Gold worklist: TRUE old-gold leads only — a qual note AND an SQL date (a past
 * sales-qualified moment worth reviving), ranked by revival score. Dead leads
 * (record_dead) sink to the bottom with their reason — visible, never hidden.
 * Shows leads regardless of exported/reviewed status (it's a mining tab, not a
 * fresh-leads queue); only dismissed leads are excluded. */
export async function listOldGold(opts: { limit?: number; offset?: number; q?: string; state?: string; subindustry?: string; scoreMin?: number; scoreMax?: number } = {}): Promise<{ companies: Company[]; total: number }> {
  const db = serviceClient();
  const limit = Math.min(opts.limit ?? 100, 1000), offset = opts.offset ?? 0;
  const known = "(timing_arrived,contract_clock,stalled_warm,lost_to_competitor,insufficient,dead)";
  const buckets: Array<{ dead: boolean; cls: string | null; other?: boolean; any?: boolean }> = [
    { dead: false, cls: "timing_arrived" }, { dead: false, cls: "contract_clock" },
    { dead: false, cls: "stalled_warm" }, { dead: false, cls: "lost_to_competitor" },
    { dead: false, cls: "insufficient" }, { dead: false, cls: null },
    { dead: false, cls: null, other: true }, { dead: false, cls: "dead" },
    { dead: true, cls: null, any: true },
  ];
  const base = (columns: string, options?: { count: "exact"; head: true }) => {
    let query: any = db.from("companies").select(columns, options)
      .eq("is_base", true)
      .or("and(qual_note.not.is.null,last_sql_date.not.is.null),record_digest.ilike.*Opportunity confirmed:*,record_digest.ilike.*Opportunity created:*")
      .not("status", "in", "(dismissed,removed_from_tam)");
    if (opts.state) query = query.eq("state", opts.state);
    if (opts.subindustry) query = query.eq("subindustry", opts.subindustry);
    if (opts.scoreMin != null) query = query.gte("oldgold_score", opts.scoreMin);
    if (opts.scoreMax != null) query = query.lte("oldgold_score", opts.scoreMax);
    if (opts.q) { const s = opts.q.replace(/[%,]/g, " ").trim(); if (s) query = query.or(`name.ilike.%${s}%,domain.ilike.%${s}%`); }
    return query;
  };
  const scoped = (query: any, bucket: typeof buckets[number]) => {
    query = query.eq("record_dead", bucket.dead);
    if (bucket.any) return query;
    if (bucket.other) return query.not("oldgold_class", "is", null).not("oldgold_class", "in", known);
    return bucket.cls == null ? query.is("oldgold_class", null) : query.eq("oldgold_class", bucket.cls);
  };
  const counts = await Promise.all(buckets.map(async (bucket) => {
    const { count, error } = await scoped(base("id", { count: "exact", head: true }), bucket);
    if (error) throw new Error(`listOldGold count failed: ${error.message}`);
    return count ?? 0;
  }));
  const total = counts.reduce((sum, value) => sum + value, 0);
  let skip = offset, needed = limit;
  const rows: any[] = [];
  for (let index = 0; index < buckets.length && needed > 0; index += 1) {
    const bucketCount = counts[index];
    if (skip >= bucketCount) { skip -= bucketCount; continue; }
    const take = Math.min(needed, bucketCount - skip);
    const { data, error } = await scoped(base("*, triggers(*), lead_insights(*)"), buckets[index])
      .order("oldgold_score", { ascending: false, nullsFirst: false })
      .order("last_sql_date", { ascending: false, nullsFirst: false })
      .order("name", { ascending: true })
      .range(skip, skip + take - 1);
    if (error) throw new Error(`listOldGold failed: ${error.message}`);
    rows.push(...(data ?? []));
    needed -= take;
    skip = 0;
  }
  const companies = rows.map((r: any) => {
      const { rest: r1, top_trigger, all_triggers, trigger_count } = withTriggers(r);
      const { rest: r2, insights } = withInsights(r1);
      return { ...mapBasic(r2), top_trigger, all_triggers, trigger_count, insights };
    });
  return { companies, total };
}

/** The Target Account List tab: EVERY tal_claimed lead, regardless of status —
 * this list is stagnant by design (exports never hide it; only a fresh TAL upload
 * changes membership). Ordering = "what needs me today": unseen alerts first,
 * dead sinks last, then the holistic TAM grade. Includes the top trigger so the
 * tab can say WHAT the alert is. */
export async function listTal(opts: { q?: string; state?: string; subindustry?: string } = {}): Promise<{ companies: (Company & { top_trigger?: { type: string; summary: string; signal_date: string | null; detected_at: string } | null; insights?: InsightBadge[] })[]; total: number }> {
  const db = serviceClient();
  let q = db.from("companies").select("*, triggers(*), lead_insights(*)", { count: "exact" }).eq("tal_claimed", true);
  if (opts.state) q = q.eq("state", opts.state);
  if (opts.subindustry) q = q.eq("subindustry", opts.subindustry);
  if (opts.q) { const s = opts.q.replace(/[%,]/g, " ").trim(); if (s) q = q.or(`name.ilike.%${s}%,domain.ilike.%${s}%`); }
  const { data, count, error } = await q
    .order("tal_alert", { ascending: false })   // fresh unseen signals float
    .order("record_dead", { ascending: true })  // dead sinks (still visible — ⛔)
    .order("tam_score", { ascending: false, nullsFirst: false })
    .order("name", { ascending: true })
    .limit(1000); // the TAL is ~250-300 by design; no paging needed
  if (error) throw new Error(`listTal failed: ${error.message}`);
  const companies = (data ?? []).map((r: any) => {
    const trigs = ((r.triggers ?? []) as TriggerRow[]).filter((trigger) => isPublishableTriggerForCompany(trigger, r));
    const rankedTriggers = trigs.map((t) => ({ t, v: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) })).sort((a, b) => b.v - a.v);
    const top = rankedTriggers[0]?.t;
    const { triggers, ...rest } = r; void triggers;
    const { rest: rest2, insights } = withInsights(rest);
    const urgency = scoreTalUrgency({
      tamScore: r.tam_score, talAlert: r.tal_alert, lastSqlDate: r.last_sql_date,
      revisitOn: r.revisit_on, recordDead: r.record_dead,
      text: [r.qual_note, r.record_digest, r.notes, r.score_reason].filter(Boolean).join("\n"),
      triggers: rankedTriggers.map(({ t, v }) => ({ live: v, type: t.type, signalDate: t.signal_date, detectedAt: t.detected_at })),
    });
    return { ...mapBasic(rest2), top_trigger: top ? { type: top.type, summary: top.summary, signal_date: top.signal_date, detected_at: top.detected_at } : null, insights, tal_urgency_score: urgency.score, tal_urgency_reasons: urgency.reasons };
  });
  companies.sort((a, b) =>
    Number(a.record_dead ?? false) - Number(b.record_dead ?? false)
    || (b.tal_urgency_score ?? 0) - (a.tal_urgency_score ?? 0)
    || (b.tam_score ?? -1) - (a.tam_score ?? -1)
    || a.name.localeCompare(b.name)
  );
  return { companies, total: count ?? 0 };
}

/** A trigger as the drawer renders it (decayed score precomputed, strongest first). */
export interface LeadTrigger extends TriggerRow { live: number }

/** Full detail for ONE lead, regardless of which tab opened it: the whole company
 * record + EVERY discovery signal + EVERY trigger (the "why it's here" events), so the
 * drawer can show everything we hold on this company across the database. */
export async function getLeadDetail(id: string): Promise<{ company: Company; triggers: LeadTrigger[]; insights: InsightBadge[]; publicGrowth: PublicGrowthDetail } | null> {
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("*, signals(*), triggers(*), lead_insights(*)").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const { signals, triggers, lead_insights, ...rest } = data as any;
  const company = mapBasic(rest);
  company.signals = Array.isArray(signals) ? signals.map(mapSignal) : [];
  const trigs: LeadTrigger[] = ((triggers ?? []) as TriggerRow[]).filter((trigger) => isPublishableTriggerForCompany(trigger, company))
    .map((t) => ({ ...t, live: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) }))
    .sort((a, b) => b.live - a.live);
  const insights: InsightBadge[] = Array.isArray(lead_insights) ? lead_insights : [];
  const publicGrowth = await getPublicGrowthDetail(id);
  return { company, triggers: trigs, insights, publicGrowth };
}
