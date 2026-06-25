import "server-only";
import { enrichCandidate } from "@/lib/ai/enrich";
import { computeSignalScore, weightForSignal } from "@/lib/scoring";
import { getScoringWeightsMap, getAppConfig } from "@/lib/db/settings";
import { normalizeDomain } from "@/lib/domain";
import { bucketForSubindustry } from "@/config/territory";
import { upsertCompanyWithSignals } from "@/lib/db/companies";
import type { Candidate } from "./types";

export interface IngestResult {
  processed: number;
  dropped_out_of_territory: number;
  dropped_non_us_canada: number;
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
    upserted: 0,
    new_companies: 0,
    added_signals: 0,
    errors: [],
  };

  // Load tunable config once per run (editable in Settings).
  const weights = await getScoringWeightsMap();
  const { model_bulk } = await getAppConfig();

  for (const c of candidates) {
    try {
      // Website-bearing sources (Google Maps, job scrapers) give a domain — the
      // dedupe key + SQL-export input. Name-only free sources (news, EDGAR,
      // USASpending) have none: store domain=null (triage row), dedupe by name.
      const domain = c.website ? normalizeDomain(c.website) || null : null;

      const enrichment = await enrichCandidate(
        { name: c.name, website: c.website, state: c.state, signals: c.signals },
        model_bulk,
      );
      result.processed++;
      if (!enrichment) {
        result.errors.push(`enrich failed for ${c.name}`);
        continue;
      }

      const isImported = c.source === "imported";
      if (!enrichment.in_territory && !isImported) {
        result.dropped_out_of_territory++;
        continue; // hard gate: out-of-territory discovered companies never surface
      }
      // Soft geo filter: drop discovered companies the LLM is confident are
      // outside the US/Canada. Imported companies (the user's own list) are kept.
      if (enrichment.clearly_outside_us_canada && !isImported) {
        result.dropped_non_us_canada++;
        continue;
      }

      // Deterministic 0–100 score from the AI-classified signals.
      const { score } = computeSignalScore(
        enrichment.signals.map((s) => ({
          type: s.type,
          strength: s.strength,
          subindustry_relevant: s.subindustry_relevant,
        })),
        weights,
      );

      // Merge AI summaries back with the original evidence (matched by source_url).
      const evidenceByUrl = new Map(c.signals.map((s) => [s.source_url, s]));
      const signals = enrichment.signals.map((s) => {
        const base = weightForSignal(s.type, s.strength, weights);
        const ev = evidenceByUrl.get(s.source_url);
        return {
          type: s.type,
          strength: s.strength,
          weight: s.subindustry_relevant ? Math.round(base * 1.25) : base,
          source_name: ev?.source_name ?? null,
          source_url: s.source_url,
          raw_excerpt: ev?.raw_excerpt ?? null,
          signal_summary: s.summary,
          subindustry_relevant: s.subindustry_relevant,
        };
      });

      const subindustry = enrichment.subindustry === "out_of_territory" ? null : enrichment.subindustry;
      const name = enrichment.company_name?.trim() || c.name;

      const res = await upsertCompanyWithSignals(
        {
          name,
          domain,
          website_raw: c.website ?? null,
          description: enrichment.description,
          subindustry,
          ns_industry: subindustry ? bucketForSubindustry(subindustry) ?? enrichment.ns_industry : null,
          in_territory: enrichment.in_territory,
          territory_fit: enrichment.territory_fit,
          source: c.source ?? "discovered",
          state: c.state ?? null,
          city: c.city ?? null,
          employee_band: c.employee_band ?? null,
          revenue_band: c.revenue_band ?? null,
          signal_score: score,
          score_tier: enrichment.score_tier,
          score_reason: enrichment.score_reason,
          sources: c.sources ?? [],
          import_batch_id: opts.importBatchId ?? null,
        },
        signals,
      );

      result.upserted++;
      if (res.isNew) result.new_companies++;
      result.added_signals += res.addedSignals;
    } catch (e) {
      result.errors.push(`${c.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}
