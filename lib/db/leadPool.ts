import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { normalizeDomain } from "@/lib/domain";
import type { Candidate } from "@/lib/ingest/types";

/**
 * The lead pool: cheap Google-Maps finds park here with NO enrichment. A
 * qualifier later checks each pooled domain for a real hiring/ERP signal and
 * promotes only the hits into `companies`. All ops are graceful before
 * migration 0004 (no-op) so the pipeline never breaks.
 */

/** Park Maps candidates (those with a resolvable domain). Returns rows offered. */
export async function addToPool(cands: Candidate[]): Promise<number> {
  const rows = cands
    .map((c) => {
      const domain = normalizeDomain(c.website);
      return domain
        ? { key: domain, name: c.name, domain, state: c.state ?? null, city: c.city ?? null, source: c.sources?.[0] ?? "google_maps" }
        : null;
    })
    .filter(Boolean) as Record<string, unknown>[];
  if (rows.length === 0) return 0;
  try {
    const db = serviceClient();
    // ignoreDuplicates so an existing pooled row keeps its checked/promoted state.
    await db.from("lead_pool").upsert(rows, { onConflict: "key", ignoreDuplicates: true });
  } catch {
    return 0;
  }
  return rows.length;
}

/** Take N un-promoted, least-recently-checked domains and stamp them checked. */
export async function getPoolDomainsToCheck(n: number): Promise<string[]> {
  try {
    const db = serviceClient();
    const { data } = await db
      .from("lead_pool")
      .select("key, domain")
      .is("promoted_at", null)
      .not("domain", "is", null)
      .order("last_checked_at", { ascending: true, nullsFirst: true })
      .limit(n);
    const rows = (data ?? []) as { key: string; domain: string | null }[];
    if (rows.length === 0) return [];
    await db.from("lead_pool").update({ last_checked_at: new Date().toISOString() }).in("key", rows.map((r) => r.key));
    return rows.map((r) => r.domain).filter(Boolean) as string[];
  } catch {
    return [];
  }
}

/** Mark pooled domains promoted (a signal was found → now a company). */
export async function markPoolPromoted(domains: string[]): Promise<void> {
  const keys = domains.map((d) => normalizeDomain(d)).filter(Boolean);
  if (keys.length === 0) return;
  try {
    const db = serviceClient();
    await db.from("lead_pool").update({ promoted_at: new Date().toISOString() }).in("key", keys);
  } catch {
    /* table missing → no-op */
  }
}

/** Mark pooled leads exported (by pool key) so they leave the Net-New tab. */
export async function markPoolExported(keys: string[]): Promise<void> {
  const clean = keys.filter(Boolean);
  if (clean.length === 0) return;
  try {
    const db = serviceClient();
    await db.from("lead_pool").update({ exported_at: new Date().toISOString() }).in("key", clean);
  } catch {
    /* column/table missing → no-op */
  }
}

export interface PoolLead {
  key: string;
  name: string;
  domain: string | null;
  state: string | null;
  city: string | null;
  first_seen_at: string;
  promoted_at: string | null;
  exported_at: string | null;
}

/** Read net-new leads (the Maps pool) for the Net-New Leads tab, newest first.
 * Falls back gracefully if the exported_at column isn't present yet (pre-0008). */
export async function getPoolLeads(limit = 2000): Promise<PoolLead[]> {
  try {
    const db = serviceClient();
    const full = await db
      .from("lead_pool")
      .select("key, name, domain, state, city, first_seen_at, promoted_at, exported_at")
      .order("first_seen_at", { ascending: false })
      .limit(limit);
    if (!full.error) return (full.data ?? []) as PoolLead[];
    // exported_at column missing → older schema; read without it.
    const { data } = await db
      .from("lead_pool")
      .select("key, name, domain, state, city, first_seen_at, promoted_at")
      .order("first_seen_at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as Omit<PoolLead, "exported_at">[]).map((p) => ({ ...p, exported_at: null }));
  } catch {
    return [];
  }
}

/** Pool stats for the dashboard/health checks. */
export async function getPoolStats(): Promise<{ total: number; unchecked: number; promoted: number }> {
  try {
    const db = serviceClient();
    const total = (await db.from("lead_pool").select("key", { count: "exact", head: true })).count ?? 0;
    const promoted = (await db.from("lead_pool").select("key", { count: "exact", head: true }).not("promoted_at", "is", null)).count ?? 0;
    const unchecked = (await db.from("lead_pool").select("key", { count: "exact", head: true }).is("last_checked_at", null)).count ?? 0;
    return { total, unchecked, promoted };
  } catch {
    return { total: 0, unchecked: 0, promoted: 0 };
  }
}
