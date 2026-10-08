import { assertFiniteCollection, finiteCollectionAccounting, type FiniteCollectionScope } from "./finiteCollection";
import "server-only";
import { rotationBatches } from "./rotationBatches";
import { markSosChecked, pickSosCompaniesForRotation, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { fetchNewCoEntities, fetchRecentUccFilings, brandKey, lightNorm, type SosEntity, type UccFiling, type ColoradoSourceCapture } from "@/lib/sources/coSos";
import { writeSourceState } from "@/lib/intelligence/sourceState";
import { newSweepOutcomes, sweepError, type SweepOutcome, type SweepCompanyReceipt } from "./sweepOutcomes";

/**
 * Colorado state-registry watch (FREE) over the whole CO base (claimable first), two
 * signals per company in one pass:
 *  1) NEW ENTITY — a recently-formed SoS entity that LEADS with the company's brand
 *     and adds a qualifier → new subsidiary/holdco = multi-entity consolidation.
 *  2) UCC FINANCING — a new UCC-1 financing statement with the company as debtor →
 *     took secured debt (equipment/LOC) = growth investment + asset accounting.
 * Boost-only; never creates a company. Deduped by registry id / filing date.
 */
const LOOKBACK_DAYS = 150;
const UCC_LOOKBACK_DAYS = 365;

export async function sweepCoSos(limit = 200, opts: { offset?: number; sourceOnly?: boolean; collection?: FiniteCollectionScope } = {}) {
  assertFiniteCollection(opts.collection, { ...opts, limit });
  const accounting = finiteCollectionAccounting(opts.collection);
  if (opts.sourceOnly && process.env.STANLEY_INTELLIGENCE_ENABLED !== "true") throw new Error("Source-only Colorado registry requires evidence capture");
  const stats = { ...newSweepOutcomes(), checked: 0, matched: 0, triggered: 0, ucc: 0, sourceOnly: opts.sourceOnly === true, receipts: [] as SweepCompanyReceipt[] };
  const sinceISO = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  const uccSinceISO = new Date(Date.now() - UCC_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 19);
  const touched = new Set<string>();

  for await (const slice of rotationBatches(
    (n, offset) => opts.collection ? pickSosCompaniesForRotation("CO", n, offset, opts.collection) : pickSosCompaniesForRotation("CO", n, offset),
    { limit, batchSize: 6, offset: opts.offset },
  )) {
    stats.checked += slice.length;
    await Promise.all(slice.map(async (c) => {
      let outcome: SweepOutcome = "failed", reason = "collection_failed", stage = "entity_lookup";
      let captured = false, truncated = false, completionStamped = false;
      let entities: SosEntity[] = [], filings: UccFiling[] = [];
      const rawCaptures: ColoradoSourceCapture[] = [];
      stats.attempted++;
      try {
        const brand = brandKey(c.name); // distinctive ≥2-token brand, or null
        if (!brand || brand.upper.replace(/[^A-Z0-9]/g, "").length < 6) { outcome = "skipped"; reason = "name_not_safe_for_lookup"; return; }
        const captureOptions = { strict: true, onTruncated: () => { truncated = true; },
          ...(opts.sourceOnly ? { onCapture: (capture: ColoradoSourceCapture) => { rawCaptures.push(capture); } } : {}) };

        // 1) new-entity (subsidiary/holdco) watch
        entities = await fetchNewCoEntities(brand.upper, sinceISO, 10, captureOptions);
        captured = true;
        stage = "entity_trigger_write";
        for (const e of entities) {
          const enToks = lightNorm(e.name).split(" ").filter(Boolean);
          // NEW subsidiary pattern: entity name LEADS with the full brand token
          // sequence (token-boundary prefix) AND adds ≥1 qualifier ("West", "Holdings",
          // "II", "Logistics"…). Excludes the company's own re-registration.
          const isPrefix = brand.tokens.every((t, idx) => enToks[idx] === t);
          if (!isPrefix || enToks.length <= brand.tokens.length) continue;
          stats.matched++;
          if (opts.sourceOnly) continue;
          const url = `https://www.sos.state.co.us/biz/BusinessEntityDetail.do?masterFileId=${e.id}&entityId2=${e.id}`;
          if (await recordTrigger(c.id, {
            type: "new_entity",
            summary: `New CO entity "${e.name}" (${e.type}) formed ${e.formed.slice(0, 10)}${e.city ? `, ${e.city}` : ""} — likely a new subsidiary/holdco (multi-entity consolidation)`,
            source_name: "CO Secretary of State", source_url: url, signal_date: e.formed.slice(0, 19) || new Date().toISOString(),
          })) { stats.triggered++; touched.add(c.id); }
        }

        // 2) UCC financing-statement watch (debtor = this company, exact-normalized).
        // Attribution evidence ships IN the summary (same standard as SBA): as-filed
        // debtor name, city-check verdict vs our record, and the secured party (lender).
        stage = "ucc_lookup";
        filings = await fetchRecentUccFilings(c.name, uccSinceISO, captureOptions);
        stage = "ucc_trigger_write";
        for (const f of filings) {
          if (opts.sourceOnly) continue;
          const day = f.filed.slice(0, 10);
          const cn = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z]/g, "");
          const check = c.city && f.debtorCity
            ? (cn(c.city) === cn(f.debtorCity) ? "✓ city verified" : `⚠ verify: debtor in ${f.debtorCity}, your record says ${c.city}`)
            : "city unrecorded — check the as-filed name";
          const detail = [`filed as "${f.debtorAsFiled}"${f.debtorCity ? ` (${f.debtorCity}, CO)` : ""}`, f.securedParty ? `lender: ${f.securedParty}` : ""].filter(Boolean).join("; ");
          if (await recordTrigger(c.id, {
            type: "ucc_financing",
            summary: `New UCC-1 financing statement filed ${day} — took secured financing (equipment/line of credit). ${check}. ${detail}`,
            source_name: "CO Secretary of State (UCC)",
            source_url: `https://data.colorado.gov/resource/wffy-3uut.json#${encodeURIComponent(lightNorm(c.name))}-${day}`,
            signal_date: f.filed.slice(0, 19) || new Date().toISOString(),
          })) { stats.ucc++; touched.add(c.id); }
        }
        outcome = truncated ? "partial" : "succeeded";
        reason = truncated ? "result_limit_reached" : "entity_and_ucc_lookups_captured";
      } catch (error) {
        outcome = stage.endsWith("lookup") ? (captured ? "partial" : "unavailable") : "failed";
        reason = `${stage}_failed`;
        sweepError(stats, "cosos", stage, error, c.id);
      } finally {
        try {
          await writeSourceState(c.id, "cosos", {
            cursor: { entities, filings, rawCaptures, truncated, observedAt: new Date().toISOString(), query: c.name, entitySince: sinceISO, uccSince: uccSinceISO,
              collectionMode: opts.sourceOnly ? "source_only" : "legacy" },
            complete: outcome === "succeeded", successful: captured,
            status: outcome === "succeeded" ? (entities.length || filings.length ? "complete" : "empty") : outcome === "partial" ? "partial" : outcome === "skipped" ? "unsupported" : "unavailable",
            details: { reason, captured, truncated }, ...(outcome === "succeeded" ? {} : { error: reason }),
          });
          if (outcome === "succeeded") { await markSosChecked([c.id]); completionStamped = true; }
        } catch (error) { outcome = "failed"; reason = "checkpoint_failed"; sweepError(stats, "cosos", "checkpoint", error, c.id); }
        stats[outcome]++;
        accounting.record(c.id, outcome);
        stats.receipts.push({ companyId: c.id, outcome, reason, captured, complete: outcome === "succeeded", completionStamped });
      }
    }));
  }

  for (const id of touched) {
    try { await recomputePriority(id); } catch (error) { sweepError(stats, "cosos", "priority", error, id); }
  }
  return { ...stats, ...accounting.result() };
}
