import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import type { Company, Signal, CompanySource, ScoreTier, SignalType, SignalStrength } from "@/lib/types";

const COMPANY_COLUMNS =
  "id, name, domain, website_raw, description, subindustry, ns_industry, in_territory, territory_fit, source, status, state, city, employee_band, revenue_band, signal_score, score_tier, score_reason, has_new_signal, sources, import_batch_id, notes, first_seen_at, last_updated_at, exported_at";

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
    .select(`${COMPANY_COLUMNS}, signals(*)`)
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
    .map((s) => ({ ...s, company_id: companyId, detected_at: now }));

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
    .select(`${COMPANY_COLUMNS}, signals(*)`)
    .eq("import_batch_id", batchId)
    .order("signal_score", { ascending: false });
  if (error) throw new Error(`getCompaniesByBatch failed: ${error.message}`);
  return (data ?? []).map((r) => mapCompany(r as Record<string, unknown>));
}

/** Record an export and mark the companies exported (so they never resurface as new). */
export async function recordExport(
  type: "sql" | "csv",
  ids: string[],
  payload: string,
): Promise<void> {
  const db = serviceClient();
  const { error: exErr } = await db
    .from("exports")
    .insert({ export_type: type, company_ids: ids, payload });
  if (exErr) throw new Error(`recordExport failed: ${exErr.message}`);
  await setCompaniesStatus(ids, type === "sql" ? "exported_sql" : "exported_csv");
}
