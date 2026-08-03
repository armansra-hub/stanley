/**
 * TAM and Old Gold are NetSuite-record judgments. Public and scraped signals are
 * ranked independently in the Triggered worklist and must never change either
 * score.
 */

export interface TriggerRow {
  type: string;
  signal_date?: string | null;
  detected_at?: string | null;
  half_life_days?: number | null;
}

export interface AdjustInput {
  record_dead?: boolean | null;
  erp_incumbent?: string | null;
  pe_owned?: boolean | null;
  headcount_growth_pct?: number | string | null;
  record_digest?: string | null;
  verdict?: string | null;
}

export type Verdict = "disqualified" | "weak" | "viable";

export interface Adjustment {
  score: number;
  bump: number;
  penalty: number;
  hardZeroReason: string | null;
  reasons: string[];
  note: string;
  verdict?: Verdict;
}

const VERDICT_PHRASES: { phrase: string; verdict: Verdict }[] = [
  { phrase: "points to disqualification", verdict: "disqualified" },
  { phrase: "some historical fit or pain exists", verdict: "weak" },
  { phrase: "credible erp potential", verdict: "viable" },
];

export function readVerdict(rawScore: number, digest?: string | null, explicit?: string | null): Verdict {
  const stated = String(explicit ?? "").toLowerCase();
  if (stated === "disqualified" || stated === "weak" || stated === "viable") return stated as Verdict;
  const text = (digest ?? "").toLowerCase();
  for (const { phrase, verdict } of VERDICT_PHRASES) if (text.includes(phrase)) return verdict;
  return rawScore < 20 ? "weak" : "viable";
}

/** Retained for Triggered ranking callers and backwards-compatible tests. */
export function decayFactor(t: TriggerRow, today = new Date()): number {
  const ref = (t.signal_date || t.detected_at || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) return 0.5;
  const ageDays = Math.max(0, Math.round((today.getTime() - new Date(`${ref}T00:00:00Z`).getTime()) / 86_400_000));
  const halfLife = Number(t.half_life_days) || 30;
  return 0.5 ** (ageDays / halfLife);
}

/**
 * Preserve the raw NetSuite-derived score exactly. Record-dead and confirmed
 * NetSuite-incumbent flags are themselves record facts, so their existing hard
 * zeros remain authoritative. Everything else belongs only in Triggered.
 */
export function adjustScore(rawScore: number, company: AdjustInput, _triggers: TriggerRow[], _today = new Date()): Adjustment {
  if (company.record_dead) {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: "record dead", reasons: [], note: "hard 0 - record dead" };
  }
  if (company.erp_incumbent === "netsuite") {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: "already on NetSuite", reasons: [], note: "hard 0 - already on NetSuite" };
  }
  if (rawScore <= 0) {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: null, reasons: [], note: "graded 0 - decisive" };
  }

  return {
    score: Math.max(0, Math.min(100, rawScore)),
    bump: 0,
    penalty: 0,
    hardZeroReason: null,
    reasons: [],
    note: "",
    verdict: readVerdict(rawScore, company.record_digest, company.verdict),
  };
}
