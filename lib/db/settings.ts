import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { DEFAULT_WEIGHTS, type ScoringWeights } from "@/lib/scoring";

export interface AppConfig {
  model_bulk: string;
  model_chat: string;
  chunk_size: number;
  sql_url_field: string;
  ns_stage: string;
  ns_sales_rep: string;
  max_cost_per_run_usd: number;
  actors: Record<string, { enabled?: boolean }>;
}

const APP_COLUMNS = "model_bulk, model_chat, chunk_size, sql_url_field, ns_stage, ns_sales_rep, max_cost_per_run_usd, actors";

export async function getAppConfig(): Promise<AppConfig> {
  const db = serviceClient();
  const { data, error } = await db.from("app_config").select(APP_COLUMNS).eq("id", 1).single();
  if (error) throw new Error(`getAppConfig failed: ${error.message}`);
  return {
    model_bulk: data.model_bulk,
    model_chat: data.model_chat,
    chunk_size: data.chunk_size,
    sql_url_field: data.sql_url_field,
    ns_stage: data.ns_stage,
    ns_sales_rep: data.ns_sales_rep,
    max_cost_per_run_usd: Number(data.max_cost_per_run_usd),
    actors: (data.actors as AppConfig["actors"]) ?? {},
  };
}

export async function updateAppConfig(patch: Partial<AppConfig>): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("app_config")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`updateAppConfig failed: ${error.message}`);
}

/** Scoring weights from the DB, merged over code defaults (DB wins). */
export async function getScoringWeightsMap(): Promise<ScoringWeights> {
  const db = serviceClient();
  const { data, error } = await db.from("scoring_weights").select("signal_type, strength, weight");
  if (error) throw new Error(`getScoringWeightsMap failed: ${error.message}`);
  const out: ScoringWeights = { ...DEFAULT_WEIGHTS };
  for (const r of data ?? []) out[`${r.signal_type}:${r.strength}`] = Number(r.weight);
  return out;
}

export async function updateScoringWeights(
  rows: { signal_type: string; strength: string; weight: number }[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = serviceClient();
  const { error } = await db.from("scoring_weights").upsert(rows, { onConflict: "signal_type,strength" });
  if (error) throw new Error(`updateScoringWeights failed: ${error.message}`);
}

export async function setTerritoryConfig(t: {
  states: string[];
  subindustries: string[];
  naics_codes: string[];
  revenue_min?: number | null;
  revenue_max?: number | null;
  employees_min?: number | null;
  employees_max?: number | null;
}): Promise<void> {
  const db = serviceClient();
  const { error } = await db
    .from("territory_config")
    .update({ ...t, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw new Error(`setTerritoryConfig failed: ${error.message}`);
}

/** Per-actor enabled overrides stored in app_config.actors; undefined = use code default. */
export async function getActorOverrides(): Promise<Record<string, { enabled?: boolean }>> {
  return (await getAppConfig()).actors;
}

export async function setActorEnabled(key: string, enabled: boolean): Promise<void> {
  const cfg = await getAppConfig();
  const actors = { ...cfg.actors, [key]: { ...(cfg.actors[key] ?? {}), enabled } };
  await updateAppConfig({ actors });
}
