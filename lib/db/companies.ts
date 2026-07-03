import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { markPoolExported } from "@/lib/db/leadPool";
import { normalizeDomain } from "@/lib/domain";
import { importBlockReason } from "@/config/territory";
import { VENDOR_WEIGHT, fitWeightFor, parseTechnologies, isErpReady, parseEmployees, employeeBand, type LeadVendor } from "@/lib/baseImport";
import type { BaseRow } from "@/lib/csv";
import type { Company, Signal, CompanySource, ScoreTier, SignalType, SignalStrength } from "@/lib/types";

export function mapSignal(r: Record<string, unknown>): Signal {
  return {
    id: String(r.id),
    company_id: String(r.company_id),
    type: r.type as Signal["type"],
    strength: (r.strength as Signal["strength"]) ?? "medium",
    weight: Number(r.weight ?? 0),
    source_name: (r.source_name as string) ?? null,
    source_url: String(r.source_url ?? ""),
    raw_excerpt: (r.raw_excerpt as string) ?? null,
    signal_summary: (r.signal_summary as string) ?? null,
    subindustry_relevant: Boolean(r.subindustry_relevant),
    detected_at: String(r.detected_at ?? ""),
    signal_date: (r.signal_date as string) ?? null,
  };
}

function mapCompany(r: Record<string, unknown>): Company {
  const signals = Array.isArray(r.signals) ? (r.signals as Record<string, unknown>[]).map(mapSignal) : [];
  return {
    id: String(r.id),
    name: String(r.name),
    domain: (r.domain as string) ?? null,
    website_raw: (r.website_raw as string) ?? null,
    description: (r.description as string) ?? null,
    subindustry: (r.subindustry as string) ?? null,
    ns_industry: (r.ns_industry as string) ?? null,
    in_territory: Boolean(r.in_territory),
    territory_fit: r.territory_fit == null ? null : Number(r.territory_fit),
    source: (r.source as Company["source"]) ?? "discovered",
    status: (r.status as Company["status"]) ?? "new",
    state: (r.state as string) ?? null,
    city: (r.city as string) ?? null,
    employee_band: (r.employee_band as string) ?? null,
    revenue_band: (r.revenue_band as string) ?? null,
    signal_score: Number(r.signal_score ?? 0),
    score_tier: (r.score_tier as Company["score_tier"]) ?? null,
    score_reason: (r.score_reason as string) ?? null,
    has_new_signal: Boolean(r.has_new_signal),
    already_on_netsuite: Boolean(r.already_on_netsuite),
    starred: Boolean(r.starred),
    rating: r.rating != null ? Number(r.rating) : null,
    rating_comment: (r.rating_comment as string) ?? null,
    sources: Array.isArray(r.sources) ? (r.sources as string[]) : [],
    notes: (r.notes as string) ?? null,
    first_seen_at: String(r.first_seen_at ?? ""),
    last_updated_at: String(r.last_updated_at ?? ""),
    exported_at: (r.exported_at as string) ?? null,
    is_base: Boolean(r.is_base),
    lead_vendor: (r.lead_vendor as string) ?? null,
    fit_weight: r.fit_weight != null ? Number(r.fit_weight) : 1,
    technologies: Array.isArray(r.technologies) ? (r.technologies as string[]) : [],
    erp_ready: Boolean(r.erp_ready),
    employee_count: r.employee_count != null ? Number(r.employee_count) : null,
    lists: Array.isArray(r.lists) ? (r.lists as string[]) : [],
    claimable: Boolean(r.claimable),
    netsuite_internal_id: (r.netsuite_internal_id as string) ?? null,
    erp_incumbent: (r.erp_incumbent as string) ?? null,
    pe_owned: Boolean(r.pe_owned),
    tal_claimed: Boolean(r.tal_claimed),
    tal_dq: Boolean(r.tal_dq),
    tal_alert: Boolean(r.tal_alert),
    thumbs_down: Boolean(r.thumbs_down),
    headcount_growth_pct: r.headcount_growth_pct != null ? Number(r.headcount_growth_pct) : null,
    has_parent: Boolean(r.has_parent), parent_name: (r.parent_name as string) ?? null, parent_confidence: (r.parent_confidence as string) ?? null,
    // Old Gold intelligence — migration 0030 (all graceful pre-migration)
    last_sql_date: (r.last_sql_date as string) ?? null,
    qual_note: (r.qual_note as string) ?? null,
    oldgold_score: r.oldgold_score != null ? Number(r.oldgold_score) : null,
    oldgold_class: (r.oldgold_class as string) ?? null,
    oldgold_reasons: Array.isArray(r.oldgold_reasons) ? (r.oldgold_reasons as string[]) : null,
    record_digest: (r.record_digest as string) ?? null,
    record_dead: Boolean(r.record_dead),
    record_dead_reason: (r.record_dead_reason as string) ?? null,
    revisit_on: (r.revisit_on as string) ?? null,
    signals,
  };
}

/** Read all companies (with nested signals) for the dashboard, highest score first. */
/** The DISCOVERED set only (signal-found leads + old imports) — small, loads client-side
 * for the Discovered/Starred/History tabs. The huge TAM Base (is_base) is server-paged
 * separately via listBaseCompanies so 14k+ rows never hit the browser at once. */
export async function getCompanies(): Promise<Company[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("companies")
    .select(`*, signals(*)`)
    .or("is_base.is.null,is_base.eq.false")
    .order("signal_score", { ascending: false })
    .limit(2000);
  if (error) throw new Error(`getCompanies failed: ${error.message}`);
  return (data ?? []).map((r) => mapCompany(r as Record<string, unknown>));
}

export interface BaseFilter { tags?: string[]; matchAll?: boolean; claimable?: boolean; erp?: boolean; state?: string; q?: string; limit?: number; offset?: number; includeHidden?: boolean }

/** "6/15/2024" / "06-15-2024" / "2024-06-15" → "2024-06-15" (Postgres date), else null. */
function usDateToIso(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  const yr = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${yr}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** Statuses that hide a lead from the active worklist (reviewed/dismissed/exported). */
const HIDDEN_STATUSES = "(reviewed,dismissed,exported_csv,exported_sql)";

/** Server-side, paginated, filtered query over the TAM Base (is_base=true). Ordered
 * claimable-first then by fit_weight (multi-list overlaps float up). Hidden leads
 * (reviewed/dismissed/exported) are excluded unless includeHidden — so exporting a
 * batch makes it drop out and the next leads surface on refetch. */
export async function listBaseCompanies(f: BaseFilter): Promise<{ companies: Company[]; total: number }> {
  const db = serviceClient();
  let q = db.from("companies").select(`*, signals(*)`, { count: "exact" }).eq("is_base", true);
  if (f.claimable) q = q.eq("claimable", true);
  if (f.erp) q = q.eq("erp_ready", true);
  if (f.state) q = q.eq("state", f.state);
  if (!f.includeHidden) q = q.not("status", "in", HIDDEN_STATUSES);
  if (f.tags?.length) q = f.matchAll ? q.contains("lists", f.tags) : q.overlaps("lists", f.tags);
  if (f.q) { const s = f.q.replace(/[%,]/g, " ").trim(); if (s) q = q.or(`name.ilike.%${s}%,domain.ilike.%${s}%`); }
  const limit = Math.min(f.limit ?? 100, 1000), offset = f.offset ?? 0;
  // TAM Base ordering = "most likely to pop off NOW" (AE decision 2026-07-02):
  // record-dead leads sink to the bottom, then the 0-100 lead-record grade
  // (oldgold_score) descending, then claimable/fit as tiebreaks.
  q = q.order("record_dead", { ascending: true })
    .order("oldgold_score", { ascending: false, nullsFirst: false })
    .order("claimable", { ascending: false })
    .order("fit_weight", { ascending: false })
    .order("name", { ascending: true });
  const { data, count, error } = await q.range(offset, offset + limit - 1);
  if (error) throw new Error(`listBaseCompanies failed: ${error.message}`);
  return { companies: (data ?? []).map((r) => mapCompany(r as Record<string, unknown>)), total: count ?? 0 };
}

/** Every starred lead, regardless of tab/source/status (Starred shows everything you
 * flagged — discovered, TAM-base, triggered, even already-exported). */
export async function listStarred(): Promise<Company[]> {
  const db = serviceClient();
  const { data, error } = await db.from("companies").select(`*, signals(*)`).eq("starred", true).order("name", { ascending: true });
  if (error) throw new Error(`listStarred failed: ${error.message}`);
  return (data ?? []).map((r) => mapCompany(r as Record<string, unknown>));
}

/** Distinct list-tags AND subindustries across the base (for the filter UI). One scan.
 * Subindustries come back as the labels the data ACTUALLY uses (the TAM upload uses a
 * few coarse buckets like "Advertising, Media & Publishing"), so the dropdown matches
 * reality instead of the granular config list. */
export async function listBaseTags(): Promise<{ tags: { tag: string; count: number }[]; subindustries: string[] }> {
  const db = serviceClient();
  const tagCounts = new Map<string, number>();
  const subs = new Map<string, number>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("lists, subindustry, claimable").eq("is_base", true).range(from, from + 999);
    const batch = (data ?? []) as { lists?: string[]; subindustry?: string | null; claimable?: boolean }[];
    for (const c of batch) {
      for (const l of c.lists ?? []) tagCounts.set(l, (tagCounts.get(l) ?? 0) + 1);
      // Subindustry facet is for the claimable worklists (Triggered/Starred), so only
      // count claimable rows → a short, relevant list (no off-territory base noise).
      if (c.claimable && c.subindustry) subs.set(c.subindustry, (subs.get(c.subindustry) ?? 0) + 1);
    }
    if (batch.length < 1000) break;
  }
  return {
    tags: [...tagCounts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count),
    subindustries: [...subs.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s),
  };
}

export interface CompanyUpsert {
  name: string;
  domain: string | null;
  website_raw: string | null;
  description: string;
  subindustry: string | null;
  ns_industry: string | null;
  in_territory: boolean;
  territory_fit: number;
  source: CompanySource;
  state?: string | null;
  city?: string | null;
  employee_band?: string | null;
  revenue_band?: string | null;
  signal_score: number;
  score_tier: ScoreTier;
  score_reason: string;
  sources: string[];
  import_batch_id?: string | null;
}

export interface SignalUpsert {
  type: SignalType;
  strength: SignalStrength;
  weight: number;
  source_name: string | null;
  source_url: string;
  raw_excerpt: string | null;
  signal_summary: string;
  subindustry_relevant: boolean;
  signal_date?: string | null;
}

/**
 * Idempotent upsert keyed on normalized domain. Never resets an existing
 * company's status/exported_at/notes (so exported companies don't resurface).
 * Signals are append-only, deduped by source_url. For imported companies, a
 * genuinely new signal flips has_new_signal (drives the notification dot).
 */
export async function upsertCompanyWithSignals(
  company: CompanyUpsert,
  signals: SignalUpsert[],
): Promise<{ companyId: string; isNew: boolean; addedSignals: number }> {
  const db = serviceClient();
  const now = new Date().toISOString();

  // Dedupe on domain when present, else on name (name-only free sources).
  let existing: { id: string; source: string } | null = null;
  if (company.domain) {
    const { data } = await db
      .from("companies")
      .select("id, source")
      .eq("domain", company.domain)
      .maybeSingle();
    existing = (data as { id: string; source: string } | null) ?? null;
  } else if (company.name.trim().toLowerCase() === "name unavailable") {
    existing = null; // unknown companies are never deduped — each is a distinct lead
  } else {
    const { data } = await db
      .from("companies")
      .select("id, source")
      .is("domain", null)
      .ilike("name", company.name)
      .limit(1);
    existing = ((data as { id: string; source: string }[] | null) ?? [])[0] ?? null;
  }

  const mutableFields = {
    name: company.name,
    website_raw: company.website_raw,
    description: company.description,
    subindustry: company.subindustry,
    ns_industry: company.ns_industry,
    in_territory: company.in_territory,
    territory_fit: company.territory_fit,
    state: company.state ?? null,
    city: company.city ?? null,
    employee_band: company.employee_band ?? null,
    revenue_band: company.revenue_band ?? null,
    signal_score: company.signal_score,
    score_tier: company.score_tier,
    score_reason: company.score_reason,
    sources: company.sources,
    last_updated_at: now,
  };

  let companyId: string;
  let isNew: boolean;

  if (existing) {
    companyId = existing.id as string;
    isNew = false;
    const { error } = await db.from("companies").update(mutableFields).eq("id", companyId);
    if (error) throw new Error(`company update failed: ${error.message}`);
  } else {
    const { data, error } = await db
      .from("companies")
      .insert({
        ...mutableFields,
        domain: company.domain,
        source: company.source,
        status: "new",
        import_batch_id: company.import_batch_id ?? null,
        first_seen_at: now,
      })
      .select("id")
      .single();
    if (error) throw new Error(`company insert failed: ${error.message}`);
    companyId = data.id as string;
    isNew = true;
  }

  // Append-only signals, deduped by source_url.
  const { data: existingSignals } = await db
    .from("signals")
    .select("source_url")
    .eq("company_id", companyId);
  const seen = new Set((existingSignals ?? []).map((s) => s.source_url as string));
  const toInsert = signals
    .filter((s) => s.source_url && !seen.has(s.source_url))
    .map((s) => ({ ...s, company_id: companyId, detected_at: now, signal_date: s.signal_date ?? null }));

  if (toInsert.length > 0) {
    const { error } = await db.from("signals").insert(toInsert);
    if (error) throw new Error(`signals insert failed: ${error.message}`);
    // New signal on an existing imported company → light up the dot.
    if (!isNew && existing?.source === "imported") {
      await db.from("companies").update({ has_new_signal: true }).eq("id", companyId);
    }
  }

  return { companyId, isNew, addedSignals: toInsert.length };
}

/** Star/unstar companies. Starred companies persist in the Starred tab regardless
 * of status/export. Safe before migration 0004 (no-op). */
export async function setStarred(ids: string[], value: boolean): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = serviceClient();
    await db.from("companies").update({ starred: value }).in("id", ids);
  } catch {
    /* column missing → no-op */
  }
}

/** Per-lead thumbs-down toggle (negative counterpart to starred; no tab). Safe
 * before migration 0024 (no-op). */
export async function setThumbsDown(ids: string[], value: boolean): Promise<void> {
  if (ids.length === 0) return;
  try {
    const db = serviceClient();
    await db.from("companies").update({ thumbs_down: value }).in("id", ids);
  } catch {
    /* column missing → no-op */
  }
}

/** Flag a company as already on NetSuite/ERP. Safe before migration 0003 (no-op). */
export async function setAlreadyOnNetsuite(id: string, value: boolean): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("companies").update({ already_on_netsuite: value }).eq("id", id);
  } catch {
    // column missing → no-op
  }
}

/** Set the AE's 1–5 quality rating (+ optional comment) on a lead. Safe before
 * migration 0009 (no-op). Feeds the learning loop (lib/learn/feedback.ts). */
export async function setRating(id: string, rating: number | null, comment?: string | null): Promise<void> {
  const r = rating == null ? null : Math.max(1, Math.min(5, Math.round(rating)));
  try {
    const db = serviceClient();
    await db
      .from("companies")
      .update({ rating: r, rating_comment: comment ?? null, rated_at: r == null ? null : new Date().toISOString() })
      .eq("id", id);
  } catch {
    // columns missing → no-op
  }
}

/** Set status on companies. Stamps exported_at when moving to an exported status. */
export async function setCompaniesStatus(ids: string[], status: Company["status"]): Promise<void> {
  if (ids.length === 0) return;
  const db = serviceClient();
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { status, last_updated_at: now };
  if (status === "exported_sql" || status === "exported_csv") patch.exported_at = now;
  else if (status === "new") patch.exported_at = null; // restore/un-export clears the stamp
  // Chunk the id set — a single .in() with thousands of UUIDs overflows the request
  // URL (bulk TAM exports can mark 7k+ rows at once).
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await db.from("companies").update(patch).in("id", ids.slice(i, i + 200));
    if (error) throw new Error(`setCompaniesStatus failed: ${error.message}`);
  }
}

export async function setCompanyNote(id: string, notes: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("companies")
    .update({ notes, last_updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`setCompanyNote failed: ${error.message}`);
}

/** Clear the new-signal notification dot for an imported company. */
export async function acknowledgeCompany(id: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("companies").update({ has_new_signal: false }).eq("id", id);
  if (error) throw new Error(`acknowledgeCompany failed: ${error.message}`);
}

export async function getTerritoryConfig(): Promise<{
  subindustries: string[];
  states: string[];
  naics_codes: string[];
  revenue_min: number | null;
  revenue_max: number | null;
  employees_min: number | null;
  employees_max: number | null;
}> {
  const db = serviceClient();
  const { data, error } = await db
    .from("territory_config")
    .select("subindustries, states, naics_codes, revenue_min, revenue_max, employees_min, employees_max")
    .single();
  if (error) throw new Error(`getTerritoryConfig failed: ${error.message}`);
  return data as {
    subindustries: string[];
    states: string[];
    naics_codes: string[];
    revenue_min: number | null;
    revenue_max: number | null;
    employees_min: number | null;
    employees_max: number | null;
  };
}

export async function patchTerritoryConfig(patch: {
  add_states?: string[];
  add_subindustries?: string[];
  remove_states?: string[];
  remove_subindustries?: string[];
}): Promise<{ states: string[]; subindustries: string[] }> {
  const db = serviceClient();
  const cur = await getTerritoryConfig();
  const merge = (arr: string[], add?: string[], rem?: string[]) => {
    const s = new Set(arr);
    (add ?? []).forEach((x) => s.add(x));
    (rem ?? []).forEach((x) => s.delete(x));
    return [...s];
  };
  const states = merge(cur.states, patch.add_states, patch.remove_states);
  const subindustries = merge(cur.subindustries, patch.add_subindustries, patch.remove_subindustries);
  const { error } = await db
    .from("territory_config")
    .update({ states, subindustries, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`patchTerritoryConfig failed: ${error.message}`);
  return { states, subindustries };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BaseImportReport { total: number; imported: number; updated: number; blocked: number; no_domain: number; dropped: number }

/** The list whose membership = "available to claim". */
export const CLAIMABLE_LIST = "netsuite_tam";

/**
 * Load a SILO (one named CSV list, e.g. "netsuite_tam" / "zoominfo_growth") into the
 * base. Each company is ONE row tagged with every list it appears on (`lists[]`);
 * `claimable` = membership in netsuite_tam. Lists are NEVER cross-deduped — importing
 * a list only ADDS its tag to matching companies + inserts new ones. Re-uploading a
 * list refreshes ONLY that list: companies dropped from it lose the tag (kept for
 * monitoring), nothing else is touched. NetSuite is SOURCE OF TRUTH (wins field
 * conflicts). Fast + deterministic, no per-row LLM.
 */
export async function bulkImportBase(rows: BaseRow[], vendor: LeadVendor, listKey: string, batchId: string | null): Promise<BaseImportReport> {
  const db = serviceClient();
  const now = new Date().toISOString();
  const isTruth = vendor === "netsuite"; // NetSuite overrides core firmographics
  const report: BaseImportReport = { total: rows.length, imported: 0, updated: 0, blocked: 0, no_domain: 0, dropped: 0 };

  // 1. hard-block (every source) + dedupe within the file
  const byKey = new Map<string, { row: BaseRow; domain: string }>();
  for (const r of rows) {
    if (importBlockReason(r.industry, r.name)) { report.blocked++; continue; }
    const domain = normalizeDomain(r.website);
    if (!domain) report.no_domain++;
    const key = domain || `name:${r.name.trim().toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { row: r, domain });
  }
  const items = [...byKey.values()];

  // 2. which domains already exist (chunked lookups)
  const existing = new Map<string, { id: string; sources: string[]; lists: string[]; lead_vendor: string | null }>();
  const domains = items.map((i) => i.domain).filter(Boolean);
  for (let i = 0; i < domains.length; i += 200) {
    const { data } = await db.from("companies").select("id, domain, sources, lists, lead_vendor").in("domain", domains.slice(i, i + 200));
    for (const c of (data ?? []) as any[]) existing.set(c.domain, { id: c.id, sources: c.sources ?? [], lists: c.lists ?? [], lead_vendor: c.lead_vendor ?? null });
  }

  // 3. partition into inserts + cross-source merges (tagging this list)
  const inserts: any[] = [];
  for (const { row, domain } of items) {
    const techs = parseTechnologies(row.technologies);
    const erp = isErpReady(techs);
    const emp = parseEmployees(row.employees);
    const ex = domain ? existing.get(domain) : undefined;
    if (ex) {
      const sources = Array.from(new Set([...(ex.sources ?? []), vendor]));
      const lists = Array.from(new Set([...(ex.lists ?? []), listKey])); // ADD this list, keep the others
      const patch: any = { is_base: true, sources, lists, claimable: lists.includes(CLAIMABLE_LIST), fit_weight: fitWeightFor(sources), last_updated_at: now };
      if (techs.length) { patch.technologies = techs; patch.erp_ready = erp; }
      if (emp != null) { patch.employee_count = emp; patch.employee_band = employeeBand(emp); }
      if (isTruth) {
        patch.lead_vendor = "netsuite";
        patch.name = row.name.trim();
        if (row.industry) patch.subindustry = row.industry;
        if (row.state) patch.state = row.state;
        if (row.city) patch.city = row.city;
        if (row.revenue) patch.revenue_band = row.revenue;
        if (row.internal_id) patch.netsuite_internal_id = row.internal_id;
        // Old Gold columns (migration 0030) — raw storage; the analysis pass hashes the
        // note and only re-analyzes leads whose note text actually changed.
        if (row.qual_note) patch.qual_note = row.qual_note;
        if (row.last_sql_date) { const d = usDateToIso(row.last_sql_date); if (d) patch.last_sql_date = d; }
      } else if (!ex.lead_vendor) {
        patch.lead_vendor = vendor;
      }
      await db.from("companies").update(patch).eq("id", ex.id);
      report.updated++;
    } else {
      inserts.push({
        name: row.name.trim(), domain: domain || null, website_raw: row.website || null,
        subindustry: row.industry || null, state: row.state || null, city: row.city || null,
        employee_count: emp, employee_band: employeeBand(emp), revenue_band: row.revenue || null,
        technologies: techs.length ? techs : null, erp_ready: erp,
        netsuite_internal_id: vendor === "netsuite" ? (row.internal_id || null) : null,
        qual_note: vendor === "netsuite" ? (row.qual_note || null) : null,
        last_sql_date: vendor === "netsuite" ? usDateToIso(row.last_sql_date) : null,
        is_base: true, lead_vendor: vendor, fit_weight: VENDOR_WEIGHT[vendor], sources: [vendor],
        lists: [listKey], claimable: listKey === CLAIMABLE_LIST,
        source: "imported", in_territory: true, status: "new", import_batch_id: batchId,
        first_seen_at: now, last_updated_at: now,
      });
    }
  }

  // 4. bulk insert the new ones (chunked). Import is purely ADDITIVE — it only adds
  //    this list's tag; companies that LEFT the list are pruned separately (a
  //    deliberate monthly-refresh step) so chunked uploads can't accidentally drop.
  for (let i = 0; i < inserts.length; i += 500) {
    const chunk = inserts.slice(i, i + 500);
    const { error } = await db.from("companies").insert(chunk);
    if (error) throw new Error(`base import insert failed: ${error.message}`);
    report.imported += chunk.length;
  }
  return report;
}

/**
 * Monthly-refresh prune: after re-uploading the FULL list, drop the list tag from any
 * company that was in it before but isn't in the new file (it LEFT the list — e.g. a
 * NetSuite-TAM lead someone claimed). The company row is KEPT (still monitored); it
 * just loses this membership (and `claimable` if it was netsuite_tam's last tag).
 * `keepDomains` = every normalized domain in the freshly-uploaded list.
 */
export async function pruneListMembership(listKey: string, keepDomains: Set<string>): Promise<number> {
  const db = serviceClient();
  // Everyone currently tagged with this list.
  const tagged: { id: string; domain: string | null; lists: string[] }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("id, domain, lists").contains("lists", [listKey]).range(from, from + 999);
    const batch = (data ?? []) as any[];
    tagged.push(...batch);
    if (batch.length < 1000) break;
  }
  let dropped = 0;
  for (const c of tagged) {
    if (c.domain && keepDomains.has(c.domain)) continue; // still in the list
    const lists = (c.lists ?? []).filter((l: string) => l !== listKey);
    await db.from("companies").update({ lists, claimable: lists.includes(CLAIMABLE_LIST), last_updated_at: new Date().toISOString() }).eq("id", c.id);
    dropped++;
  }
  return dropped;
}

/** Normalize a company name to a comparison key: lowercase, strip accents +
 * punctuation, drop common legal/entity suffixes, collapse whitespace. Used to
 * cross-tag domain-less leads (Sales Nav Growth) against the named-keyed TAM. */
const NAME_NOISE = /\b(llc|l\.l\.c|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|enterprises|the|and)\b/g;
export function normalizeCompanyName(name: string): string {
  return (name || "")
    .toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(NAME_NOISE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BaseMembership { lists: string[]; claimable: boolean; netsuite_internal_id: string | null }

/** Build a normalizedName → TAM-membership index over the whole base (is_base=true),
 * merging rows that collapse to the same key. For cross-tagging by name. */
export async function loadBaseNameIndex(): Promise<Map<string, BaseMembership>> {
  const db = serviceClient();
  const map = new Map<string, BaseMembership>();
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("name, lists, claimable, netsuite_internal_id").eq("is_base", true).range(from, from + 999);
    const batch = (data ?? []) as any[];
    for (const c of batch) {
      const key = normalizeCompanyName(c.name);
      if (!key) continue;
      const lists: string[] = Array.isArray(c.lists) ? c.lists : [];
      const ex = map.get(key);
      if (!ex) map.set(key, { lists: [...lists], claimable: !!c.claimable, netsuite_internal_id: c.netsuite_internal_id ?? null });
      else {
        ex.lists = Array.from(new Set([...ex.lists, ...lists]));
        ex.claimable = ex.claimable || !!c.claimable;
        if (!ex.netsuite_internal_id && c.netsuite_internal_id) ex.netsuite_internal_id = c.netsuite_internal_id;
      }
    }
    if (batch.length < 1000) break;
  }
  return map;
}

/** Cross-tag DISCOVERED leads against the base by normalized name: a match inherits
 * the base company's lists + claimable + NetSuite Internal ID (additive — keeps any
 * tags the lead already had). Targets are typically domain-less Growth leads that the
 * domain dedup can't reach. Returns the number tagged. */
export async function crossTagByName(
  targets: { id: string; name: string; lists?: string[] }[],
  index: Map<string, BaseMembership>,
): Promise<number> {
  if (targets.length === 0) return 0;
  const db = serviceClient();
  const now = new Date().toISOString();
  let tagged = 0;
  for (const t of targets) {
    const hit = index.get(normalizeCompanyName(t.name));
    if (!hit || hit.lists.length === 0) continue;
    const lists = Array.from(new Set([...(t.lists ?? []), ...hit.lists]));
    const patch: Record<string, unknown> = { lists, claimable: hit.claimable || lists.includes(CLAIMABLE_LIST), last_updated_at: now };
    if (hit.netsuite_internal_id) patch.netsuite_internal_id = hit.netsuite_internal_id;
    const { error } = await db.from("companies").update(patch).eq("id", t.id);
    if (!error) tagged++;
  }
  return tagged;
}

/**
 * Sync the ARS Target Account List as a DIFF against the prior upload:
 *   • a lead whose domain/name is on the NEW TAL  → tal_claimed=true,  tal_dq=false
 *     (red "ARS TAL CLAIMED"; reclaiming clears any prior DQ);
 *   • a lead that was tal_claimed but is MISSING from the new TAL → tal_claimed=false,
 *     tal_dq=true ("PREVIOUSLY DQ'd" — the AE dropped it);
 *   • everyone else is left untouched (prior DQ flags persist).
 * Match is exact (normalized domain / name equality) → precise, no fuzzy positives.
 */
export async function syncTalClaimed(rows: { name: string; website?: string | null }[]): Promise<{ tal_count: number; matched: number; newly_dq: number }> {
  const db = serviceClient();
  const talNames = new Set<string>();
  const talDomains = new Set<string>();
  for (const r of rows) {
    const nn = normalizeCompanyName(r.name);
    if (nn) talNames.add(nn);
    const d = normalizeDomain(r.website || "");
    if (d) talDomains.add(d);
  }
  if (talNames.size === 0 && talDomains.size === 0) return { tal_count: rows.length, matched: 0, newly_dq: 0 };

  // Scan every company; classify against the new TAL + its current claimed state.
  const claimedIds: string[] = []; // on the new TAL → claimed
  const dqIds: string[] = [];      // was claimed, now missing → previously DQ'd
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from("companies").select("id, domain, name, tal_claimed").range(from, from + 999);
    const batch = (data ?? []) as { id: string; domain: string | null; name: string; tal_claimed: boolean }[];
    for (const c of batch) {
      const d = c.domain ? normalizeDomain(c.domain) : "";
      const nn = normalizeCompanyName(c.name);
      const onTal = (d && talDomains.has(d)) || (nn && talNames.has(nn));
      if (onTal) claimedIds.push(c.id);
      else if (c.tal_claimed) dqIds.push(c.id); // fell off the list → DQ
    }
    if (batch.length < 1000) break;
  }
  // Apply (chunked — a single .in() with thousands of ids overflows the URL).
  for (let i = 0; i < claimedIds.length; i += 200) {
    await db.from("companies").update({ tal_claimed: true, tal_dq: false }).in("id", claimedIds.slice(i, i + 200));
  }
  for (let i = 0; i < dqIds.length; i += 200) {
    await db.from("companies").update({ tal_claimed: false, tal_dq: true }).in("id", dqIds.slice(i, i + 200));
  }
  return { tal_count: rows.length, matched: claimedIds.length, newly_dq: dqIds.length };
}

/** Create an import batch row; returns its id. */
export async function createImportBatch(filename: string, rowCount: number): Promise<string> {
  const db = serviceClient();
  const { data, error } = await db
    .from("import_batches")
    .insert({ filename, row_count: rowCount })
    .select("id")
    .single();
  if (error) throw new Error(`createImportBatch failed: ${error.message}`);
  return data.id as string;
}

export async function setImportBatchEnriched(id: string, count: number): Promise<void> {
  const db = serviceClient();
  await db.from("import_batches").update({ enriched_count: count }).eq("id", id);
}

/** Read the companies (with signals) that belong to one import batch. */
export async function getCompaniesByBatch(batchId: string): Promise<Company[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("companies")
    .select(`*, signals(*)`)
    .eq("import_batch_id", batchId)
    .order("signal_score", { ascending: false });
  if (error) throw new Error(`getCompaniesByBatch failed: ${error.message}`);
  return (data ?? []).map((r) => mapCompany(r as Record<string, unknown>));
}

export type ExportOrigin = "discovered" | "net_new";

/**
 * Record an export. For 'discovered' (companies) we mark the companies exported
 * so they never resurface as new. For 'net_new' (Maps pool leads) we mark the
 * pooled leads exported so they leave the Net-New tab — the `ids` are pool keys
 * (normalized domains), NOT company ids.
 */
export async function recordExport(
  type: "sql" | "csv",
  ids: string[],
  payload: string,
  origin: ExportOrigin = "discovered",
): Promise<void> {
  const db = serviceClient();
  let exErr = (await db.from("exports").insert({ export_type: type, company_ids: ids, payload, origin })).error;
  if (exErr) {
    // origin column missing (pre-0008) → insert without it.
    exErr = (await db.from("exports").insert({ export_type: type, company_ids: ids, payload })).error;
  }
  if (exErr) throw new Error(`recordExport failed: ${exErr.message}`);
  if (origin === "net_new") {
    await markPoolExported(ids);
  } else {
    await setCompaniesStatus(ids, type === "sql" ? "exported_sql" : "exported_csv");
  }
}

export interface ExportRecord {
  id: string;
  export_type: "sql" | "csv";
  origin: ExportOrigin;
  company_ids: string[];
  company_names: string[];
  /** name + website for every lead in the export, so the UI can regenerate
   * EITHER SQL or CSV on demand (not just the format originally chosen). */
  export_companies: { name: string; website: string | null }[];
  payload: string;
  created_at: string;
}

export async function getExportHistory(): Promise<ExportRecord[]> {
  const db = serviceClient();
  const withOrigin = await db
    .from("exports")
    .select("id, export_type, origin, company_ids, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(200);
  // origin column missing (pre-0008) → read without it; treat all as discovered.
  const fallback = withOrigin.error
    ? await db
        .from("exports")
        .select("id, export_type, company_ids, payload, created_at")
        .order("created_at", { ascending: false })
        .limit(200)
    : null;
  const error = fallback ? fallback.error : withOrigin.error;
  const data = (fallback ? fallback.data : withOrigin.data) as Record<string, unknown>[] | null;
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return [];

  const allIds = [...new Set(data.flatMap((r) => (r.company_ids as string[])))];
  // id → {name, website}. Discovered ids are company ids (website from
  // website_raw/domain); net_new ids are lead_pool keys (the key IS the domain).
  const infoMap = new Map<string, { name: string; website: string | null }>();
  if (allIds.length > 0) {
    const [cos, pool] = await Promise.all([
      db.from("companies").select("id, name, website_raw, domain").in("id", allIds),
      db.from("lead_pool").select("key, name, domain").in("key", allIds),
    ]);
    for (const c of cos.data ?? []) {
      infoMap.set(c.id as string, { name: c.name as string, website: (c.website_raw as string) ?? (c.domain as string) ?? null });
    }
    for (const p of pool.data ?? []) {
      if (!infoMap.has(p.key as string)) {
        infoMap.set(p.key as string, { name: p.name as string, website: (p.domain as string) ?? (p.key as string) ?? null });
      }
    }
  }

  return data.map((r) => {
    const ids = r.company_ids as string[];
    const export_companies = ids.map((id) => infoMap.get(id) ?? { name: id, website: null });
    return {
      id: r.id as string,
      export_type: r.export_type as "sql" | "csv",
      origin: ((r.origin as string) ?? "discovered") as ExportOrigin,
      company_ids: ids,
      company_names: export_companies.map((c) => c.name),
      export_companies,
      payload: (r.payload as string) ?? "",
      created_at: r.created_at as string,
    };
  });
}
