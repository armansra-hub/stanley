import { assertFiniteCollection, finiteCollectionAccounting, type FiniteCollectionScope } from "./finiteCollection";
import "server-only";
import { rotationBatches } from "./rotationBatches";
import { pickCarriersForRotation, markFmcsaChecked, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { normalizeCompanyName } from "@/lib/db/companies";
import { isGenericName } from "@/lib/triggers/sweep";
import { fetchCarrierByName, type CarrierRecord, type FmcsaSourceCapture } from "@/lib/sources/fmcsa";
import { getFmcsaSnapshot, upsertFmcsaSnapshot, type FmcsaSnapshot } from "@/lib/db/fmcsa";
import { writeSourceState } from "@/lib/intelligence/sourceState";
import { newSweepOutcomes, sweepError, type SweepOutcome, type SweepCompanyReceipt } from "./sweepOutcomes";

/**
 * FMCSA fleet-growth monitor (FREE) — watches the TAM's TRANSPORTATION companies.
 * For each carrier, looks up its FMCSA census record by name and compares the
 * power-unit count to the last snapshot. A ≥15% fleet increase = an expansion
 * signal (more assets/maintenance/depreciation accounting than QuickBooks handles)
 * → `fleet_expansion` trigger. First sight = baseline (store, no trigger); deltas
 * fire on later runs. Boost-only; never creates a company.
 */
export async function sweepFmcsaTam(limit = 150, opts: { offset?: number; sourceOnly?: boolean; collection?: FiniteCollectionScope } = {}) {
  assertFiniteCollection(opts.collection, { ...opts, limit });
  const accounting = finiteCollectionAccounting(opts.collection);
  if (opts.sourceOnly && process.env.STANLEY_INTELLIGENCE_ENABLED !== "true") throw new Error("Source-only FMCSA requires evidence capture");
  const stats = { ...newSweepOutcomes(), checked: 0, matched: 0, fleet_growth: 0, sourceOnly: opts.sourceOnly === true, receipts: [] as SweepCompanyReceipt[] };
  const touched = new Set<string>();

  for await (const slice of rotationBatches(opts.collection ? (n, offset) => pickCarriersForRotation(n, offset, opts.collection) : pickCarriersForRotation, { limit, batchSize: 8, offset: opts.offset })) {
    await Promise.all(slice.map(async (c) => {
      let outcome: SweepOutcome = "failed", reason = "collection_failed", stage = "lookup";
      let captured = false, truncated = false, completionStamped = false;
      let records: CarrierRecord[] = [];
      const rawCaptures: FmcsaSourceCapture[] = [];
      let prior: FmcsaSnapshot | null = null, priorSnapshotRead = false;
      let matchedDot: string | null = null;
      stats.attempted++;
      try {
        const cn = normalizeCompanyName(c.name);
        if (!cn || cn.length < 4 || isGenericName(cn)) { outcome = "skipped"; reason = "name_not_safe_for_lookup"; return; }
        records = await fetchCarrierByName(c.name, 5, { strict: true, onTruncated: () => { truncated = true; },
          ...(opts.sourceOnly ? { onCapture: (capture: FmcsaSourceCapture) => { rawCaptures.push(capture); } } : {}) });
        captured = true;
        const m = records.find((r) => {
          const a = normalizeCompanyName(r.dba || r.legal);
          return a && (a.includes(cn) || cn.includes(a));
        });
        if (!m || !m.dot) { outcome = truncated ? "partial" : "succeeded"; reason = truncated ? "result_limit_reached" : "no_candidate_in_name_lookup"; return; }
        matchedDot = m.dot;
        stats.matched++;
        if (m.units === null || m.drivers === null) { outcome = "partial"; reason = "fleet_metrics_unavailable"; return; }
        stage = "snapshot_read";
        prior = await getFmcsaSnapshot(m.dot, { strict: true });
        priorSnapshotRead = true;
        if (opts.sourceOnly) {
          // Retain the prior comparison baseline; advancing it here would consume
          // an unreviewed growth delta before independent interpretation.
          outcome = truncated ? "partial" : "succeeded";
          reason = truncated ? "result_limit_reached" : "comparison_captured_for_review";
          return;
        }
        stage = "trigger_write";
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
        stage = "snapshot_write";
        await upsertFmcsaSnapshot(m.dot, c.name, m.units, m.drivers, { strict: true });
        outcome = truncated ? "partial" : "succeeded";
        reason = truncated ? "result_limit_reached" : prior ? "comparison_captured" : "baseline_captured";
      } catch (error) {
        outcome = stage === "lookup" ? "unavailable" : "failed";
        reason = `${stage}_failed`;
        sweepError(stats, "fmcsa", stage, error, c.id);
      } finally {
        try {
          await writeSourceState(c.id, "fmcsa", {
            cursor: { records, rawCaptures, truncated, observedAt: new Date().toISOString(), query: c.name,
              matchedDot, priorSnapshot: prior, priorSnapshotRead,
              collectionMode: opts.sourceOnly ? "source_only" : "legacy", comparisonBaselinePreserved: opts.sourceOnly === true },
            complete: outcome === "succeeded", successful: captured,
            status: outcome === "succeeded" ? (records.length ? "complete" : "empty") : outcome === "partial" ? "partial" : outcome === "skipped" ? "unsupported" : "unavailable",
            details: { reason, captured, truncated }, ...(outcome === "succeeded" ? {} : { error: reason }),
          });
          // Reservations already advance attempted rows. Never stamp a skipped,
          // partial, failed or unavailable lookup as completed.
          if (outcome === "succeeded") { await markFmcsaChecked([c.id]); completionStamped = true; }
        } catch (error) { outcome = "failed"; reason = "checkpoint_failed"; sweepError(stats, "fmcsa", "checkpoint", error, c.id); }
        stats[outcome]++;
        accounting.record(c.id, outcome);
        stats.receipts.push({ companyId: c.id, outcome, reason, captured, complete: outcome === "succeeded", completionStamped });
      }
    }));
    stats.checked += slice.length;
  }

  for (const id of touched) {
    try { await recomputePriority(id); } catch (error) { sweepError(stats, "fmcsa", "priority", error, id); }
  }
  return { ...stats, ...accounting.result() };
}
