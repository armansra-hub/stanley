/**
 * Trigger taxonomy — strength + half-life per type, and a headline classifier.
 * Pure (no I/O) so it's unit-testable. Strength = how hot the signal is; half_life
 * = how fast it decays (a funding round stays relevant longer than generic news).
 */
export interface TriggerSpec { strength: number; half_life_days: number }

export const TRIGGER_SPEC: Record<string, TriggerSpec> = {
  erp_tech: { strength: 95, half_life_days: 120 }, // runs QuickBooks, no ERP — the strongest, slowest-decaying
  funding: { strength: 90, half_life_days: 90 },   // raised money → ERP budget + growth
  new_entity: { strength: 88, half_life_days: 120 }, // new subsidiary/division → multi-entity consolidation (classic QB killer)
  ma: { strength: 85, half_life_days: 90 },         // ACQUIRER only → multi-entity/consolidation pain
  gov_contract: { strength: 82, half_life_days: 120 }, // new federal award → revenue step-change + audit/DCAA → ERP
  finance_hire: { strength: 80, half_life_days: 30 }, // hiring AP/controller → in-house finance scaling NOW
  fleet_expansion: { strength: 74, half_life_days: 150 }, // FMCSA fleet growth → multi-asset/maintenance accounting outgrows QB
  hiring_velocity: { strength: 70, half_life_days: 120 }, // FMCSA driver-count surge → payroll/ops complexity
  headcount_50: { strength: 72, half_life_days: 365 }, // crossed ~50 employees (ACA ALE threshold) per DOL 5500 — new compliance burden; annual data → slow decay
  ucc_financing: { strength: 65, half_life_days: 180 }, // new UCC-1 financing statement → took secured debt (equipment/LOC) = growth investment
  press: { strength: 50, half_life_days: 30 },      // expansion / new office
  news: { strength: 40, half_life_days: 21 },       // generic mention
};

export const TRIGGER_LABEL: Record<string, string> = {
  erp_tech: "ERP-ready (QuickBooks, no ERP)",
  funding: "Funding",
  new_entity: "New entity / subsidiary",
  ma: "Acquired a company",
  gov_contract: "Gov contract award",
  finance_hire: "Finance hire",
  fleet_expansion: "Fleet growth (FMCSA)",
  hiring_velocity: "Driver-count surge (FMCSA)",
  headcount_50: "Crossed 50 employees (ACA threshold)",
  ucc_financing: "New secured financing (UCC-1)",
  press: "Expansion",
  news: "In the news",
};

/** Classify a news headline into the strongest trigger type it implies. */
export function classifyHeadline(headline: string): keyof typeof TRIGGER_SPEC {
  const t = ` ${headline.toLowerCase()} `;
  // Funding — real capital events only: a raise/secure with an amount, a named
  // round, or a $ figure. Excludes "funding model"/"venture" prose and charity
  // fundraisers ("raises $X for charity").
  const charity = /\b(charity|charit|fundraiser|fundrais|nonprofit|non-profit|gala|donation|donates?|raises?\s+awareness)\b/.test(t);
  if (!charity && (
    // a raise/secure/close VERB followed by an amount or round (drops bare "$100K
    // careers" / "pay $100K" prose with no capital event)
    /\b(raises?|raised|secures?|secured|closes?|closed|lands?)\s+(a\s+|an\s+|its\s+)?(\$|€|£)?\d/.test(t) ||
    /\b(raises?|raised|secures?|secured)\s+(a\s+|an\s+|its\s+)?(seed|series|round|funding|capital|investment)/.test(t) ||
    /\bseries\s+[a-e]\b/.test(t) || /\bseed\s+round\b/.test(t) ||
    /\b(funding|investment)\s+round\b/.test(t)
  )) return "funding";
  // Multi-entity complexity — a NEW subsidiary/division/entity (the classic event
  // that outgrows QuickBooks). Checked before M&A so "forms new subsidiary" ≠ M&A.
  if (/\b(forms?|launches?|launched|establishes?|creates?|opens?|spins?\s+(off|out)|stands?\s+up|adds?)\s+(a\s+|its\s+|new\s+)*(subsidiary|division|business\s+unit|new\s+entity|new\s+company|new\s+brand|holding\s+company|affiliate)\b/.test(t) || /\bnew\s+(subsidiary|division|business\s+unit|legal\s+entity)\b/.test(t)) return "new_entity";
  if (/\b(acquires?|acquired|acquisition|merges?\b|merger|to buy|buys\b|completes?\s+(the\s+)?acquisition)/.test(t)) return "ma";
  if (/\b(controller|chief financial officer|\bcfo\b|vp of finance|head of finance|finance director|director of finance)\b/.test(t)) return "finance_hire";
  // Expansion — a concrete new site or stated expansion, not a bare "opens".
  if (/\b(expands?|expansion|new headquarters|new facility|new terminal|new warehouse|new plant|new distribution center|opens?\s+(a\s+)?(new\s+)?(office|facility|location|warehouse|terminal|plant|headquarters|branch|store)|relocat)\b/.test(t)) return "press";
  return "news";
}

/** Time-decay factor for a trigger (0..1) using its half-life. */
export function decayFactor(eventIso: string | null, detectedIso: string, halfLifeDays: number, now = Date.now()): number {
  const base = eventIso ?? detectedIso;
  const ageDays = (now - new Date(base).getTime()) / 86_400_000;
  return Math.pow(0.5, Math.max(0, ageDays) / Math.max(1, halfLifeDays));
}
