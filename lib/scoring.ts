import type { Signal, SignalType, SignalStrength } from "./types";

/**
 * Deterministic signal scoring — rules + weights only, NO AI. (The LLM produces
 * the independent A/B/C tier and the summary line; the 0–100 number is here.)
 * Defaults mirror the scoring_weights seed in 0001_init.sql; pass overrides
 * (e.g. loaded from the DB config table) to tune without code edits.
 */
export type ScoringWeights = Record<string, number>; // key: `${type}:${strength}` or `${type}:any`

export const DEFAULT_WEIGHTS: ScoringWeights = {
  "finance_hire:strong": 35,
  "finance_hire:medium": 20,
  "finance_hire:weak": 10,
  "pain_job_post:strong": 25,
  "pain_job_post:medium": 15,
  "pain_job_post:weak": 8,
  "hiring_velocity:strong": 20,
  "hiring_velocity:medium": 10,
  "hiring_velocity:weak": 5,
  "funding:any": 20,
  "m_and_a:any": 20,
  "new_location:any": 12,
  "new_service:any": 10,
  "ex_netsuite_alum:any": 12,
  "tech_stack:any": 8,
  "intent:any": 8,
  "job_post:any": 8,
  "news:any": 8,
  // complexity-spike events — the thesis: NetSuite wins when complexity outgrows QuickBooks
  "new_entity:any": 22, // multi-entity consolidation = the #1 QuickBooks-killer
  "gov_contract:any": 18, // revenue step-change + DCAA/audit compliance
  "fleet_expansion:any": 14, // asset / maintenance / depreciation accounting
  "new_facility:any": 12, // multi-location inventory + 3PL billing + WMS
  "new_service_line:any": 12, // multiple revenue streams = revenue recognition
};

/** Weight for a single signal: prefer an exact type:strength rule, else type:any. */
export function weightForSignal(
  type: SignalType,
  strength: SignalStrength,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  return weights[`${type}:${strength}`] ?? weights[`${type}:any`] ?? 0;
}

export interface ScoreResult {
  /** Capped 0–100 sum of signal weights. */
  score: number;
  /** Per-signal weights, in input order (uncapped). */
  breakdown: number[];
}

/**
 * Sum a company's signal weights, capped at 100. Subindustry-relevant signals
 * get a +25% nudge (mentor's rule: vertical-specific signals outrank generic
 * growth) before the cap.
 */
export function computeSignalScore(
  signals: Pick<Signal, "type" | "strength" | "subindustry_relevant">[],
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): ScoreResult {
  const breakdown = signals.map((s) => {
    const base = weightForSignal(s.type, s.strength, weights);
    return s.subindustry_relevant ? Math.round(base * 1.25) : base;
  });
  const score = Math.min(100, breakdown.reduce((a, b) => a + b, 0));
  return { score, breakdown };
}

export type ScoreBand = "Strong" | "Medium" | "Weak";

export function scoreBand(score: number): ScoreBand {
  if (score >= 60) return "Strong";
  if (score >= 30) return "Medium";
  return "Weak";
}
