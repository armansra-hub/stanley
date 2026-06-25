import "server-only";
import { enrichCandidate, type Enrichment } from "@/lib/ai/enrich";
import { computeSignalScore, weightForSignal } from "@/lib/scoring";
import { getScoringWeightsMap, getAppConfig, getSignalQuality } from "@/lib/db/settings";
import { normalizeDomain } from "@/lib/domain";
import { bucketForSubindustry } from "@/config/territory";
import { isOnOrAfterMinDate, recencyMultiplier, nowMs } from "@/lib/time";
import { upsertCompanyWithSignals, setAlreadyOnNetsuite } from "@/lib/db/companies";
import type { Candidate } from "./types";

export interface IngestResult {
  processed: number;
  dropped_out_of_territory: number;
  dropped_non_us_canada: number;
  dropped_too_large: number;
  dropped_too_small: number;
  dropped_no_finance_team: number;
  dropped_junior_role: number;
  dropped_3pl: number;
  dropped_unidentified: number;
  dropped_stale: number;
  upserted: number;
  new_companies: number;
  added_signals: number;
  errors: string[];
}

/**
 * The shared pipeline: candidate → AI enrich (territory + tier + summaries) →
 * deterministic 0–100 score → upsert. Out-of-territory DISCOVERED companies are
 * dropped before they reach the dashboard; imported ones are kept and flagged.
 * Every source adapter funnels its candidates through here.
 */
export async function ingestCandidates(
  candidates: Candidate[],
  opts: { importBatchId?: string } = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    processed: 0,
    dropped_out_of_territory: 0,
    dropped_non_us_canada: 0,
    dropped_too_large: 0,
    dropped_too_small: 0,
    dropped_no_finance_team: 0,
    dropped_junior_role: 0,
    dropped_3pl: 0,
    dropped_unidentified: 0,
    dropped_stale: 0,
    upserted: 0,
    new_companies: 0,
    added_signals: 0,
    errors: [],
  };

  // Load tunable config once per run (editable in Settings).
  const baseWeights = await getScoringWeightsMap();
  const { model_bulk } = await getAppConfig();
  // Learned quality multipliers (from lead ratings) fold into the weights per
  // signal type, so the score continuously tunes toward what the AE rates highly.
  const quality = await getSignalQuality();
  const weights = Object.fromEntries(
    Object.entries(baseWeights).map(([key, w]) => {
      const type = key.split(":")[0];
      return [key, Math.round(w * (quality[type] ?? 1))];
    }),
  );
  const ref = nowMs();

  // ── Phase 1: recency-filter, then ENRICH IN PARALLEL (the AI call is the
  // bottleneck; parallelizing keeps a big free-discovery batch under the 60s
  // function cap). DB writes stay sequential in phase 2 to avoid dedupe races. ──
  type Prepared = { candidate: Candidate; isImported: boolean };
  const toEnrich: Prepared[] = [];
  for (const c of candidates) {
    const isImported = c.source === "imported";
    const hadSignals = c.signals.length > 0;
    const freshSignals = c.signals.filter((s) => isOnOrAfterMinDate(s.signal_date));
    if (hadSignals && freshSignals.length === 0 && !isImported) {
      result.processed++;
      result.dropped_stale++;
      continue;
    }
    toEnrich.push({ candidate: { ...c, signals: freshSignals }, isImported });
  }

  const CONCURRENCY = 6;
  const enriched: ({ candidate: Candidate; isImported: boolean; enrichment: Enrichment | null } | undefined)[] =
    new Array(toEnrich.length);
  let cursor = 0;
  async function enrichWorker() {
    for (let i = cursor++; i < toEnrich.length; i = cursor++) {
      const { candidate, isImported } = toEnrich[i];
      try {
        const enrichment = await enrichCandidate(
          { name: candidate.name, website: candidate.website, state: candidate.state, signals: candidate.signals },
          model_bulk,
        );
        enriched[i] = { candidate, isImported, enrichment };
      } catch (e) {
        enriched[i] = { candidate, isImported, enrichment: null };
        result.errors.push(`${candidate.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toEnrich.length) }, enrichWorker));

  // ── Phase 2: gates + score + upsert, SEQUENTIAL (one domain at a time). ──
  for (const item of enriched) {
    if (!item) continue;
    const { candidate, isImported, enrichment } = item;
    try {
      result.processed++;
      if (!enrichment) {
        result.errors.push(`enrich failed for ${candidate.name}`);
        continue;
      }

      // Website-bearing sources give a domain (dedupe key + SQL-export input);
      // name-only free sources have none → domain=null (triage row, dedupe by name).
      const domain = candidate.website ? normalizeDomain(candidate.website) || null : null;

      const resolvedName = (enrichment.company_name?.trim() || candidate.name).trim();

      // Unidentified-company gate: a lead with no real company name is a waste of
      // time — never add it (discovered only; imported rows have a real name).
      if (!isImported && (!resolvedName || resolvedName.toLowerCase() === "name unavailable")) {
        result.dropped_unidentified++;
        continue;
      }
      // Territory-trusted candidates (e.g. industry-filtered Sales Nav) are kept
      // even if the LLM can't reconfirm the subindustry from a bare company name.
      const inTerritory = enrichment.in_territory || candidate.trusted === true;
      if (!inTerritory && !isImported) {
        result.dropped_out_of_territory++;
        continue; // hard gate: out-of-territory discovered companies never surface
      }
      // Soft geo filter: drop discovered companies the LLM is confident are
      // outside the US/Canada. Imported companies (the user's own list) are kept.
      if (enrichment.clearly_outside_us_canada && !isImported) {
        result.dropped_non_us_canada++;
        continue;
      }
      // Size gate (upper): ICP is $0–$30M revenue SMB — drop obvious enterprises.
      if (enrichment.clearly_too_large && !isImported) {
        result.dropped_too_large++;
        continue;
      }
      // Size gate (lower): require ~20+ employees — drop verifiable micro-firms.
      if (enrichment.clearly_too_small && !isImported) {
        result.dropped_too_small++;
        continue;
      }
      // Finance-team gate: drop only when the LLM can VERIFY there's no finance
      // function (unknown finance footprint is kept — "if not, that's ok").
      if (enrichment.clearly_no_finance_team && !isImported) {
        result.dropped_no_finance_team++;
        continue;
      }
      // Decision-maker gate: only leadership/decision-making personas are worth
      // it — drop discovered leads whose only evidence is a junior role.
      if (enrichment.junior_role_only && !isImported) {
        result.dropped_junior_role++;
        continue;
      }
      // 3PL gate: freight/logistics stays, but true third-party logistics
      // providers are blocked.
      if (enrichment.is_3pl && !isImported) {
        result.dropped_3pl++;
        continue;
      }

      // Per-signal recency factor (newer = higher), keyed by source_url.
      const evidenceByUrl = new Map(candidate.signals.map((s) => [s.source_url, s]));
      const recencyByUrl = new Map(
        candidate.signals.map((s) => [s.source_url, recencyMultiplier(s.signal_date, ref)]),
      );

      // Deterministic 0–100 score from the AI-classified signals, recency-scaled.
      const { score } = computeSignalScore(
        enrichment.signals.map((s) => ({
          type: s.type,
          strength: s.strength,
          subindustry_relevant: s.subindustry_relevant,
          recency: recencyByUrl.get(s.source_url) ?? 1,
        })),
        weights,
      );

      // Merge AI summaries back with the original evidence (matched by source_url).
      const signals = enrichment.signals.map((s) => {
        const base = weightForSignal(s.type, s.strength, weights);
        const ev = evidenceByUrl.get(s.source_url);
        const rec = recencyByUrl.get(s.source_url) ?? 1;
        const vertical = s.subindustry_relevant ? base * 1.25 : base;
        return {
          type: s.type,
          strength: s.strength,
          weight: Math.round(vertical * rec),
          source_name: ev?.source_name ?? null,
          source_url: s.source_url,
          raw_excerpt: ev?.raw_excerpt ?? null,
          signal_summary: s.summary,
          subindustry_relevant: s.subindustry_relevant,
          signal_date: ev?.signal_date ?? null,
        };
      });

      const subindustry = enrichment.subindustry === "out_of_territory" ? null : enrichment.subindustry;

      const res = await upsertCompanyWithSignals(
        {
          name: resolvedName,
          domain,
          website_raw: candidate.website ?? null,
          description: enrichment.description,
          subindustry,
          ns_industry: subindustry ? bucketForSubindustry(subindustry) ?? enrichment.ns_industry : null,
          in_territory: inTerritory,
          territory_fit: enrichment.territory_fit,
          source: candidate.source ?? "discovered",
          state: candidate.state ?? null,
          city: candidate.city ?? null,
          employee_band: candidate.employee_band ?? null,
          revenue_band: candidate.revenue_band ?? null,
          signal_score: score,
          score_tier: enrichment.score_tier,
          score_reason: enrichment.score_reason,
          sources: candidate.sources ?? [],
          import_batch_id: opts.importBatchId ?? null,
        },
        signals,
      );

      result.upserted++;
      if (res.isNew) result.new_companies++;
      result.added_signals += res.addedSignals;
      if (enrichment.already_on_netsuite) await setAlreadyOnNetsuite(res.companyId, true);
    } catch (e) {
      result.errors.push(`${candidate.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
