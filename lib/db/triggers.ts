import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { TRIGGER_SPEC, decayFactor } from "@/lib/triggers/config";
import { mapSignal } from "@/lib/db/companies";
import type { Company } from "@/lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TriggerInput { type: string; summary: string; source_name?: string; source_url?: string | null; signal_date?: string | null }
export interface TriggerRow { id: string; company_id: string; type: string; strength: number; half_life_days: number; summary: string; source_name: string | null; source_url: string | null; signal_date: string | null; detected_at: string }

/** Insert a trigger (deduped by company + source_url). Returns true if a NEW one landed.
 * RESURFACING: an exported/reviewed lead (NOT dismissed — that's an explicit rejection)
 * whose export is >14 days old gets flipped back to `new` when a genuinely NEW trigger
 * lands — "watch the TAM like a hawk" must include leads already pulled once, or a
 * post-export funding round would stay silently hidden forever. The 14-day grace stops
 * next-day churn on leads the AE just exported and is actively working. */
export async function recordTrigger(companyId: string, t: TriggerInput): Promise<boolean> {
  const spec = TRIGGER_SPEC[t.type] ?? TRIGGER_SPEC.news;
  const db = serviceClient();
  const { error } = await db.from("triggers").insert({
    company_id: companyId, type: t.type, strength: spec.strength, half_life_days: spec.half_life_days,
    summary: t.summary.slice(0, 280), source_name: t.source_name ?? null, source_url: t.source_url ?? null, signal_date: t.signal_date ?? null,
  });
  if (error) return false; // unique-index violation on a dupe
  try {
    const { data: c } = await db.from("companies").select("status, exported_at").eq("id", companyId).maybeSingle();
    const s = (c as any)?.status as string | undefined;
    if (s === "exported_csv" || s === "exported_sql" || s === "reviewed") {
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
 */
export async function recomputePriority(companyId: string): Promise<number> {
  const db = serviceClient();
  // select * so optional ERP-readiness columns (migration 0020) are included when present.
  const { data: c } = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
  const { data: trigs } = await db.from("triggers").select("type, strength, half_life_days, signal_date, detected_at").eq("company_id", companyId);
  const fit = Number((c as any)?.fit_weight ?? 1);
  const listBonus = 1 + 0.1 * Math.max(0, ((c as any)?.lists?.length ?? 1) - 1);
  let best = 0;
  const activeTypes = new Set<string>();
  for (const t of (trigs ?? []) as any[]) {
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
  const priority = Math.round(best * fit * listBonus * multiBonus * incumbentFactor * peFactor * deadFactor * 100) / 100;
  await db.from("companies").update({ priority }).eq("id", companyId);
  return priority;
}

/** Set ERP-readiness flags on a company (graceful no-op before migration 0020). */
export async function setErpFlags(companyId: string, flags: { pe_owned?: boolean; erp_incumbent?: string | null }): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update(flags).eq("id", companyId);
  } catch { /* columns missing pre-0020 → no-op */ }
}

/** The next batch of base companies to sweep — never-checked first, then oldest,
 * NetSuite-TAM (claimable) ahead of the rest, then highest fit. `offset` lets the
 * cron fan the day's sweep into non-overlapping parallel waves (each wave reads the
 * same ordering before any are marked checked, so disjoint slices). */
export async function pickForRotation(limit: number, offset = 0): Promise<{ id: string; name: string; domain: string | null; claimable: boolean }[]> {
  const db = serviceClient();
  // Monitor the CSV base AND live Sales Nav Growth discoveries.
  const { data } = await db.from("companies").select("id, name, domain, claimable")
    .or('is_base.eq.true,sources.cs.["sales_nav_growth"]')
    .order("last_checked_at", { ascending: true, nullsFirst: true })
    .order("claimable", { ascending: false }) // NetSuite TAM swept first
    .order("fit_weight", { ascending: false })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

export async function markChecked(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = serviceClient();
  await db.from("companies").update({ last_checked_at: new Date().toISOString() }).in("id", ids);
}

/** The next batch of base companies to ATS-check — must have a domain; longest-since
 * (or never) ats-checked first, NetSuite-TAM (claimable) ahead. `offset` for waves. */
export async function pickAtsForRotation(limit: number, offset = 0): Promise<{ id: string; name: string; domain: string; ats_type: string | null; ats_token: string | null }[]> {
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name, domain, ats_type, ats_token")
    .or("is_base.eq.true,sources.cs.[\"sales_nav_growth\"]")
    .not("domain", "is", null)
    .order("ats_checked_at", { ascending: true, nullsFirst: true })
    .order("claimable", { ascending: false })
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

/** Rotation for the slow structured-signal sweep (USAspending + EDGAR), on its own
 * cursor (signals_checked_at, migration 0021) so it doesn't fight the news sweep.
 * NetSuite-TAM first; never/longest-checked first. `offset` for parallel waves. */
export async function pickSignalsForRotation(limit: number, offset = 0): Promise<{ id: string; name: string }[]> {
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name")
    .or("is_base.eq.true,sources.cs.[\"sales_nav_growth\"]")
    .order("signals_checked_at", { ascending: true, nullsFirst: true })
    .order("claimable", { ascending: false })
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
export async function listTalCompanies(): Promise<{ id: string; name: string }[]> {
  const db = serviceClient();
  const out: { id: string; name: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("id, name").eq("tal_claimed", true).range(from, from + 999);
    const batch = (data ?? []) as { id: string; name: string }[];
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
    const trigs = (r.triggers ?? []) as TriggerRow[];
    const top = trigs.map((t) => ({ t, v: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) })).sort((a, b) => b.v - a.v)[0]?.t;
    const { triggers, ...rest } = r; void triggers;
    return { ...mapBasic(rest), priority: r.priority != null ? Number(r.priority) : 0, top_trigger: top ? { type: top.type, summary: top.summary, signal_date: top.signal_date, detected_at: top.detected_at } : null } as TriggeredCompany;
  });
}

/** Claimable leads with a domain, for the website-change watch. Ordered by
 * site_checked_at (never/longest first). Its own cursor.
 * scope: "claimable" = NetSuite TAM (the priority set, refreshed fastest);
 *        "tail" = the monitored non-claimable base (ZoomInfo-only leads) — the AE
 *        mainly works claimable but still wants the ZoomInfo TAM watched. */
export async function pickSitesForRotation(limit: number, offset = 0, scope: "claimable" | "tail" = "claimable"): Promise<{ id: string; name: string; domain: string; site_hash: string | null; site_checked_at: string | null }[]> {
  const db = serviceClient();
  const base: any = db.from("companies").select("id, name, domain, site_hash, site_checked_at")
    .eq("is_base", true).not("domain", "is", null);
  const scoped = scope === "claimable" ? base.eq("claimable", true) : base.not("claimable", "is", true);
  const { data } = await scoped
    .order("site_checked_at", { ascending: true, nullsFirst: true })
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

/** TAM carriers (transportation/trucking/logistics subindustries) for the FMCSA
 * fleet-growth monitor. Shares the signals_checked_at cursor (the gov/EDGAR sweep is
 * off on this base, so it's free). NetSuite-TAM first; `offset` for waves. */
export async function pickCarriersForRotation(limit: number, offset = 0): Promise<{ id: string; name: string }[]> {
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name")
    .eq("is_base", true)
    .or("subindustry.ilike.*truck*,subindustry.ilike.*transport*,subindustry.ilike.*logistic*,subindustry.ilike.*freight*,subindustry.ilike.*carrier*,subindustry.ilike.*warehous*,subindustry.ilike.*moving*,subindustry.ilike.*hauling*")
    .order("signals_checked_at", { ascending: true, nullsFirst: true })
    .order("claimable", { ascending: false })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

/** Base companies in a given state (for the state-registry watch: new entities + UCC).
 * Whole monitored base, claimable first — the AE watches the ZoomInfo tail too. */
export async function pickSosCompaniesForRotation(state: string, limit: number, offset = 0): Promise<{ id: string; name: string }[]> {
  const db = serviceClient();
  const { data } = await db.from("companies").select("id, name")
    .eq("is_base", true).eq("state", state)
    .order("claimable", { ascending: false })
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);
  return (data ?? []) as any[];
}

/** Map a mapCompany-shaped row + attach the top trigger (for the Triggered worklist). */
export interface TriggeredCompany extends Company { priority?: number; top_trigger?: { type: string; summary: string; signal_date: string | null; detected_at: string } | null; trigger_count?: number; trigger_types?: string[] }

/** The synthetic "signal" for DOL-5500 headcount leads in the signal-type filter
 * (they surface via headcount_growth_pct, not a trigger row). */
export const HEADCOUNT_PSEUDO_TYPE = "headcount_growth";

/** Base companies with an active trigger (priority>0), ranked by cached priority, paginated.
 * Hidden leads (reviewed/dismissed/exported) are excluded unless includeHidden.
 * opts.types = signal-type filter (multi-select in the UI): keep only leads with at
 * least one trigger of a selected type (or ≥25% headcount when the pseudo-type is
 * selected). Filtering happens after the fetch — the active triggered set is a few
 * hundred rows, so we pull it whole and paginate in memory for correct totals. */
export async function listTriggered(opts: { limit?: number; offset?: number; includeHidden?: boolean; q?: string; state?: string; subindustry?: string; band?: string; claimable?: boolean; erp?: boolean; tags?: string[]; matchAll?: boolean; types?: string[] } = {}): Promise<{ companies: TriggeredCompany[]; total: number }> {
  const db = serviceClient();
  const typeFilter = (opts.types ?? []).filter(Boolean);
  const limit = Math.min(opts.limit ?? 100, 1000), offset = opts.offset ?? 0;
  let q = db.from("companies").select("*, triggers(*)", { count: "exact" })
    .or('is_base.eq.true,sources.cs.["sales_nav_growth"]')
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
    .order("priority", { ascending: false }).order("name", { ascending: true })
    .range(typeFilter.length ? 0 : offset, typeFilter.length ? 1999 : offset + limit - 1);
  if (error) throw new Error(`listTriggered failed: ${error.message}`);
  let companies = (data ?? []).map((r: any) => {
    const trigs = (r.triggers ?? []) as TriggerRow[];
    // "Reason to call" = strongest current trigger — restricted to the selected
    // signal types when a filter is active, so the Why column shows the signal
    // you're filtering for, not an unrelated stronger one.
    const pool = typeFilter.length ? trigs.filter((t) => typeFilter.includes(t.type)) : trigs;
    const top = pool.map((t) => ({ t, v: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) }))
      .sort((a, b) => b.v - a.v)[0]?.t;
    const { triggers, ...rest } = r; void triggers;
    const trigger_types = [...new Set(trigs.map((t) => t.type))];
    return { ...mapBasic(rest), priority: r.priority != null ? Number(r.priority) : 0, top_trigger: top ? { type: top.type, summary: top.summary, signal_date: top.signal_date, detected_at: top.detected_at } : null, trigger_count: trigs.length, trigger_types } as TriggeredCompany;
  });
  if (typeFilter.length) {
    const wantHeadcount = typeFilter.includes(HEADCOUNT_PSEUDO_TYPE);
    companies = companies.filter((c) =>
      (c.trigger_types ?? []).some((t) => typeFilter.includes(t)) ||
      (wantHeadcount && (c.headcount_growth_pct ?? 0) >= 25));
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
    headcount_growth_pct: r.headcount_growth_pct != null ? Number(r.headcount_growth_pct) : null,
    has_parent: Boolean(r.has_parent), parent_name: r.parent_name ?? null, parent_confidence: r.parent_confidence ?? null,
    // Old Gold intelligence — migration 0030 (graceful pre-migration)
    last_sql_date: r.last_sql_date ?? null, qual_note: r.qual_note ?? null,
    oldgold_score: r.oldgold_score != null ? Number(r.oldgold_score) : null,
    oldgold_class: r.oldgold_class ?? null,
    oldgold_reasons: Array.isArray(r.oldgold_reasons) ? r.oldgold_reasons : null,
    record_digest: r.record_digest ?? null,
    record_dead: Boolean(r.record_dead), record_dead_reason: r.record_dead_reason ?? null,
    revisit_on: r.revisit_on ?? null,
    signals: [],
  };
}

/** Old Gold worklist: every lead with a qual note, ranked by revival score. Dead
 * leads (record_dead) sink to the bottom with their reason — visible, never hidden.
 * Shows leads regardless of exported/reviewed status (it's a mining tab, not a
 * fresh-leads queue); only dismissed leads are excluded. */
export async function listOldGold(opts: { limit?: number; offset?: number; q?: string; state?: string; subindustry?: string } = {}): Promise<{ companies: Company[]; total: number }> {
  const db = serviceClient();
  const limit = Math.min(opts.limit ?? 100, 1000), offset = opts.offset ?? 0;
  let q = db.from("companies").select("*", { count: "exact" })
    .eq("is_base", true).not("qual_note", "is", null)
    .neq("status", "dismissed");
  if (opts.state) q = q.eq("state", opts.state);
  if (opts.subindustry) q = q.eq("subindustry", opts.subindustry);
  if (opts.q) { const s = opts.q.replace(/[%,]/g, " ").trim(); if (s) q = q.or(`name.ilike.%${s}%,domain.ilike.%${s}%`); }
  const { data, count, error } = await q
    .order("record_dead", { ascending: true }) // dead last
    .order("oldgold_score", { ascending: false, nullsFirst: false })
    .order("last_sql_date", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`listOldGold failed: ${error.message}`);
  return { companies: (data ?? []).map((r: any) => mapBasic(r)), total: count ?? 0 };
}

/** A trigger as the drawer renders it (decayed score precomputed, strongest first). */
export interface LeadTrigger extends TriggerRow { live: number }

/** Full detail for ONE lead, regardless of which tab opened it: the whole company
 * record + EVERY discovery signal + EVERY trigger (the "why it's here" events), so the
 * drawer can show everything we hold on this company across the database. */
export async function getLeadDetail(id: string): Promise<{ company: Company; triggers: LeadTrigger[] } | null> {
  const db = serviceClient();
  const { data, error } = await db.from("companies").select("*, signals(*), triggers(*)").eq("id", id).maybeSingle();
  if (error || !data) return null;
  const { signals, triggers, ...rest } = data as any;
  const company = mapBasic(rest);
  company.signals = Array.isArray(signals) ? signals.map(mapSignal) : [];
  const trigs: LeadTrigger[] = ((triggers ?? []) as TriggerRow[])
    .map((t) => ({ ...t, live: t.strength * decayFactor(t.signal_date, t.detected_at, t.half_life_days) }))
    .sort((a, b) => b.live - a.live);
  return { company, triggers: trigs };
}
