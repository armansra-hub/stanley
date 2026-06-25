import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { markPoolExported } from "@/lib/db/leadPool";
import type { Company, Signal, CompanySource, ScoreTier, SignalType, SignalStrength } from "@/lib/types";

function mapSignal(r: Record<string, unknown>): Signal {
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
    signals,
  };
}

/** Read all companies (with nested signals) for the dashboard, highest score first. */
export async function getCompanies(): Promise<Company[]> {
  const db = serviceClient();
  const { data, error } = await db
    .from("companies")
    .select(`*, signals(*)`)
    .order("signal_score", { ascending: false });
  if (error) throw new Error(`getCompanies failed: ${error.message}`);
  return (data ?? []).map((r) => mapCompany(r as Record<string, unknown>));
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
  const { error } = await db.from("companies").update(patch).in("id", ids);
  if (error) throw new Error(`setCompaniesStatus failed: ${error.message}`);
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
