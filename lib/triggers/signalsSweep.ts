import "server-only";
import { pickSignalsForRotation, markSignalsChecked, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { normalizeCompanyName } from "@/lib/db/companies";
import { isGenericName } from "@/lib/triggers/sweep";
import { fetchGovAwards } from "@/lib/sources/gov";
import { fetchEdgarFunding } from "@/lib/sources/edgarFts";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** True only when `other` (a USAspending recipient / EDGAR filer name) is the same
 * company — avoids matching the many similarly-named entities in those datasets. */
function nameMatches(company: string, other: string): boolean {
  const c = normalizeCompanyName(company);
  if (!c || c.length < 4 || isGenericName(c)) return false;
  const o = normalizeCompanyName(String(other).split("(")[0]); // strip EDGAR "(TICKER) (CIK …)"
  if (!o) return false;
  return o.includes(c) || c.includes(o);
}

/**
 * Structured-signal sweep (FREE): for the next batch of base companies, query
 * USAspending (new federal awards → gov_contract) and SEC EDGAR (Form D → funding)
 * BY NAME, recording a trigger only when the recipient/filer name truly matches.
 * Boost-only; never creates a company. Its own rotation cursor (signals_checked_at).
 */
export async function sweepSignals(limit = 150, opts: { offset?: number } = {}): Promise<{ checked: number; gov: number; funding: number }> {
  const companies = await pickSignalsForRotation(limit, opts.offset ?? 0);
  const stats = { checked: companies.length, gov: 0, funding: 0 };
  const touched = new Set<string>();

  const BATCH = 10;
  for (let i = 0; i < companies.length; i += BATCH) {
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        for (const a of await fetchGovAwards(c.name)) {
          if (!nameMatches(c.name, a.recipient)) continue;
          const amt = a.amount ? ` ($${Math.round(a.amount).toLocaleString()})` : "";
          const summary = `Won a federal award${amt}${a.agency ? ` from ${a.agency}` : ""}: ${a.description || a.id}`.slice(0, 280);
          if (await recordTrigger(c.id, { type: "gov_contract", summary, source_name: "USAspending", source_url: a.id ? `https://www.usaspending.gov/award/${encodeURIComponent(a.id)}` : "https://www.usaspending.gov", signal_date: a.date })) { stats.gov++; touched.add(c.id); }
        }
        for (const e of await fetchEdgarFunding(c.name)) {
          if (!nameMatches(c.name, e.name)) continue;
          if (await recordTrigger(c.id, { type: "funding", summary: `Filed SEC Form D (private capital raise) — ${e.name}`.slice(0, 280), source_name: "SEC EDGAR", source_url: `https://www.sec.gov/cgi-bin/srqsb?text=${encodeURIComponent(c.name)}`, signal_date: e.date })) { stats.funding++; touched.add(c.id); }
        }
      } catch { /* per-company isolated */ }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  await markSignalsChecked(companies.map((c) => c.id));
  return stats;
}
