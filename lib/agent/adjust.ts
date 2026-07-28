/**
 * Stanley's outside-signal layer — the ±15 adjustment that sits on top of a graded
 * close probability.
 *
 * Division of labour (Arman, 2026-07-27): **Codex owns the grade** (it reads the
 * NetSuite record and produces the raw close probability). **Stanley owns the
 * signals** — triggers from the daily sweeps, DOL-5500 headcount growth, PE
 * ownership, site-detected competitor ERP. Those are things a record reader cannot
 * see, and they must survive every regrade.
 *
 * On 2026-07-15 a grade import wrote `tam_score = codex_score` directly and wiped
 * this layer off 6,932 leads. Applying it here, at write time, makes that
 * structurally impossible: a push supplies the raw grade, and the signal layer is
 * re-derived from live data on every single write.
 *
 * Mirrors system/codex_rescore.py — same weights, same decay, same caps. That
 * script remains the bulk/offline path; this is the live one.
 */

/** Signal weight by trigger type. Money and hiring outrank chatter. */
const TRIGGER_WEIGHT: Record<string, number> = {
  funding: 6, ma: 6, finance_hire: 6,
  erp_tech: 5,
  fleet_expansion: 4, hiring_velocity: 4, headcount_50: 4, ucc_financing: 4, sba_loan: 4,
  gov_contract: 3, press: 3, news: 3, new_entity: 3,
};
const DEFAULT_WEIGHT = 2;
const ADJUSTMENT_CAP = 15;
const INCUMBENT_PENALTY = 10;
/** Below this, a signal has decayed into noise and stops counting at all. */
const LIVE_THRESHOLD = 0.25;

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
}

export interface Adjustment {
  score: number;
  bump: number;
  penalty: number;
  hardZeroReason: string | null;
  reasons: string[];
  note: string;
}

/** Freshness decay: half the weight every half_life_days (default 30). */
export function decayFactor(t: TriggerRow, today = new Date()): number {
  const ref = (t.signal_date || t.detected_at || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ref)) return 0.5; // undated signal — assume mid-life
  const ageDays = Math.max(0, Math.round((today.getTime() - new Date(`${ref}T00:00:00Z`).getTime()) / 86_400_000));
  const halfLife = Number(t.half_life_days) || 30;
  return 0.5 ** (ageDays / halfLife);
}

/**
 * Raw grade + live signals → the score the UI ranks on.
 * Hard zeros short-circuit everything: a dead record or an existing NetSuite
 * customer is not a prospect, no matter how strong its signals look.
 */
export function adjustScore(rawScore: number, company: AdjustInput, triggers: TriggerRow[], today = new Date()): Adjustment {
  if (company.record_dead) {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: "record dead", reasons: [], note: "hard 0 — record dead" };
  }
  if (company.erp_incumbent === "netsuite") {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: "already on NetSuite", reasons: [], note: "hard 0 — already on NetSuite" };
  }
  // A graded 0 is a judgment ("this is not a prospect"), not a missing value. Outside
  // signals must not quietly resurrect it — a PE owner or a press mention doesn't make
  // a disqualified company workable. Reopening one is a human call, not an automatic +3.
  if (rawScore <= 0) {
    return { score: 0, bump: 0, penalty: 0, hardZeroReason: null, reasons: [], note: "graded 0 — decisive, signals not applied" };
  }

  const reasons: string[] = [];
  let bump = 0;
  for (const t of triggers) {
    const decay = decayFactor(t, today);
    if (decay <= LIVE_THRESHOLD) continue; // decayed to noise
    const weight = (TRIGGER_WEIGHT[t.type] ?? DEFAULT_WEIGHT) * decay;
    bump += weight;
    reasons.push(`${t.type} ${Math.round(weight)}`);
  }

  const growth = Number(company.headcount_growth_pct ?? 0);
  if (growth >= 25) { bump += 5; reasons.push(`5500 headcount +${Math.round(growth)}%`); }
  if (company.pe_owned) { bump += 3; reasons.push("PE-owned"); }
  bump = Math.min(bump, ADJUSTMENT_CAP);

  let penalty = 0;
  const incumbent = company.erp_incumbent ?? "";
  if (incumbent === "erp" || incumbent === "intacct") {
    penalty = INCUMBENT_PENALTY;
    reasons.push(`-${INCUMBENT_PENALTY} competitor ERP (${incumbent})`);
  }

  const score = Math.max(0, Math.min(100, rawScore + bump - penalty));
  const parts: string[] = [];
  if (bump >= 1) parts.push(`+${Math.round(bump)} Stanley signals (${reasons.slice(0, 4).join(", ")})`);
  if (penalty) parts.push(`-${penalty} site-detected incumbent ERP (${incumbent})`);

  return {
    score: Math.round(score * 10) / 10,
    bump: Math.round(bump * 10) / 10,
    penalty,
    hardZeroReason: null,
    reasons,
    note: parts.join("; "),
  };
}
