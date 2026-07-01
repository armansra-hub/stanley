import "server-only";
import { pickCarriersForRotation, markSignalsChecked, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { normalizeCompanyName } from "@/lib/db/companies";
import { isGenericName } from "@/lib/triggers/sweep";
import { fetchCarrierByName } from "@/lib/sources/fmcsa";
import { getFmcsaSnapshot, upsertFmcsaSnapshot } from "@/lib/db/fmcsa";

/**
 * FMCSA fleet-growth monitor (FREE) — watches the TAM's TRANSPORTATION companies.
 * For each carrier, looks up its FMCSA census record by name and compares the
 * power-unit count to the last snapshot. A ≥15% fleet increase = an expansion
 * signal (more assets/maintenance/depreciation accounting than QuickBooks handles)
 * → `fleet_expansion` trigger. First sight = baseline (store, no trigger); deltas
 * fire on later runs. Boost-only; never creates a company.
 */
export async function sweepFmcsaTam(limit = 150, opts: { offset?: number } = {}): Promise<{ checked: number; matched: number; fleet_growth: number }> {
  const companies = await pickCarriersForRotation(limit, opts.offset ?? 0);
  const stats = { checked: companies.length, matched: 0, fleet_growth: 0 };
  const touched = new Set<string>();

  const BATCH = 8;
  for (let i = 0; i < companies.length; i += BATCH) {
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        const cn = normalizeCompanyName(c.name);
        if (!cn || cn.length < 4 || isGenericName(cn)) return;
        const recs = await fetchCarrierByName(c.name);
        const m = recs.find((r) => {
          const a = normalizeCompanyName(r.dba || r.legal);
          return a && (a.includes(cn) || cn.includes(a));
        });
        if (!m || !m.dot) return;
        stats.matched++;
        const prior = await getFmcsaSnapshot(m.dot).catch(() => null);
        const url = `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${m.dot}`;
        if (prior && prior.nbr_power_unit > 0 && m.units >= Math.ceil(prior.nbr_power_unit * 1.15)) {
          if (await recordTrigger(c.id, {
            type: "fleet_expansion",
            summary: `Fleet grew ${prior.nbr_power_unit}→${m.units} power units (now ${m.drivers} drivers) since ${prior.captured_at.slice(0, 10)} — FMCSA, ${m.city}, ${m.state}`,
            source_name: "FMCSA", source_url: url,
            signal_date: new Date().toISOString(),
          })) { stats.fleet_growth++; touched.add(c.id); }
        } else if (prior && prior.driver_total >= 10 && m.drivers >= Math.ceil(prior.driver_total * 1.25)) {
          // Driver-headcount surge (≥25%) without a power-unit jump — a hiring spree
          // that still outgrows QuickBooks-grade payroll/ops accounting. Distinct
          // source_url (#drivers) so it can't collide with the fleet trigger.
          const pct = Math.round(((m.drivers - prior.driver_total) / prior.driver_total) * 100);
          if (await recordTrigger(c.id, {
            type: "hiring_velocity",
            summary: `Driver count grew ${prior.driver_total}→${m.drivers} (+${pct}%) since ${prior.captured_at.slice(0, 10)} — FMCSA, ${m.city}, ${m.state}`,
            source_name: "FMCSA", source_url: `${url}#drivers`,
            signal_date: new Date().toISOString(),
          })) { stats.fleet_growth++; touched.add(c.id); }
        }
        await upsertFmcsaSnapshot(m.dot, c.name, m.units, m.drivers).catch(() => {});
      } catch { /* per-company isolated */ }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  await markSignalsChecked(companies.map((c) => c.id));
  return stats;
}
