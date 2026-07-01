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
  // Cross-tag discovered leads against the TAM base by name (migration 0019).
  // Defaults true and is resilient if the column doesn't exist yet.
  cross_tag_base: boolean;
  // Auto-dismiss high-confidence subsidiaries (migration 0029). Default true.
  parent_autodismiss: boolean;
}

export async function getAppConfig(): Promise<AppConfig> {
  const db = serviceClient();
  // select("*") so a new/optional column (e.g. cross_tag_base) is included when
  // present and simply absent (→ default) before its migration is applied.
  const { data, error } = await db.from("app_config").select("*").eq("id", 1).single();
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
    cross_tag_base: data.cross_tag_base ?? true,
    parent_autodismiss: data.parent_autodismiss ?? true,
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

// LLM classifier weekly budget gate. ~$0.0023/call on Opus 4.8 (≈290 tokens) →
// 4,000 calls/week ≈ $9, under the $10/week cap. Returns true (and increments) only
// if this week is under cap; false → caller uses the free regex classifier. If the
// counter columns are absent (pre-0026) or anything errors, returns false (no
// untracked spend). Increment isn't strictly atomic — fine for a safety bound.
const CLASSIFIER_WEEKLY_CAP_CALLS = 4000;
function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
export async function claimClassifierCall(): Promise<boolean> {
  try {
    const db = serviceClient();
    const { data, error } = await db.from("app_config").select("classifier_week, classifier_calls").eq("id", 1).single();
    if (error || !data) return false;
    const wk = isoWeek();
    const calls = (data as any).classifier_week === wk ? Number((data as any).classifier_calls ?? 0) : 0;
    if (calls >= CLASSIFIER_WEEKLY_CAP_CALLS) return false;
    await db.from("app_config").update({ classifier_week: wk, classifier_calls: calls + 1 }).eq("id", 1);
    return true;
  } catch {
    return false; // columns missing / error → no spend, regex fallback
  }
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

/** Learned per-signal-type quality multipliers (app_config.signal_quality jsonb),
 * produced by the rating feedback loop. Graceful before migration 0009. */
export async function getSignalQuality(): Promise<Record<string, number>> {
  try {
    const db = serviceClient();
    const { data, error } = await db.from("app_config").select("signal_quality").eq("id", 1).single();
    if (error) return {};
    return (data?.signal_quality as Record<string, number>) ?? {};
  } catch {
    return {};
  }
}

export async function setSignalQuality(map: Record<string, number>): Promise<void> {
  try {
    const db = serviceClient();
    await db.from("app_config").update({ signal_quality: map, updated_at: new Date().toISOString() }).eq("id", 1);
  } catch {
    /* column missing → no-op */
  }
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
