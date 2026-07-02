/**
 * Canonical territory definition — the authoritative copy used by the app
 * (filter dropdowns, the LLM classifier prompt, and validation). Keep in sync
 * with the seed in supabase/migrations/0001_init.sql.
 *
 * Decisions (2026-06-24):
 *  - SUBINDUSTRY is the HARD gate — a company that doesn't classify into one
 *    of these never reaches the dashboard.
 *  - STATES hard-filter ONLY Google Maps results (location verifiable there);
 *    other sources are not geo-gated.
 *  - Revenue / employee bands are display-only, NOT filters.
 */

/**
 * BLOCKED subindustries (2026-06-25 decision): never prospect these — low fit /
 * not worth the AE's time. Excluded from the active subindustry enum below, so
 * the classifier can't tag a company into them (→ out_of_territory → dropped),
 * they vanish from the UI filter, and the discovery actors stop searching for
 * them (config/coverage.ts + config/news.ts).
 *   • Accounting Services (incl. tax/CPA/bookkeeping — see enrich prompt)
 *   • Call Centers & Business Centers
 * NOTE: "Freight & Logistics Services" stays IN territory. We block only true
 * 3PLs (third-party logistics providers) via the LLM `is_3pl` gate in enrich.ts
 * — NOT freight/logistics broadly.
 * UN-BLOCKED 2026-07-02 (AE decision): law/legal firms are prospectable again —
 * removed from this set, from IMPORT_BLOCK_RULES, and from the enrich prompt;
 * the 39 retroactively-dismissed law firms were restored in the DB.
 */
export const BLOCKED_SUBINDUSTRIES = new Set<string>([
  "Accounting Services",
  "Call Centers & Business Centers",
]);

/**
 * Hard-block enforcement for BULK BASE IMPORT (ZoomInfo/Apollo industry strings +
 * company name). Deterministic keyword match — no LLM. Mirrors the AE's hard
 * blocks: accounting/CPA/bookkeeping/tax, law/legal, 3PL (NOT freight/logistics
 * broadly), call centers. Returns the block reason, or null to keep the row.
 */
const IMPORT_BLOCK_RULES: { reason: string; needles: string[] }[] = [
  // Needles expanded 2026-06-29 — the original set missed name shapes like "income
  // tax", which let accounting firms into the NetSuite TAM (their coarse subindustry
  // label hid them). Law/legal firms were UN-blocked 2026-07-02 (AE decision).
  { reason: "accounting/tax firm", needles: ["accounting", "accountant", "cpa", "bookkeep", "tax prep", "tax consult", "tax advisor", "tax service", "income tax", "tax & accounting", "tax associates"] },
  { reason: "3PL", needles: ["3pl", "third-party logistics", "third party logistics", "fulfillment center", "fulfillment services", "order fulfillment"] },
  { reason: "call center", needles: ["call center", "call centre", "contact center", "answering service", "telemarketing"] },
  // Government / public-sector entities aren't ERP prospects for this AE (added
  // 2026-07-01 after "Loveland Fire Rescue Authority" surfaced via UCC). Name-shape
  // needles chosen to avoid catching private firms ("City Wide Cleaning" stays).
  { reason: "government entity", needles: ["fire rescue", "fire protection district", "fire district", "school district", "public schools", "county of ", "city of ", "town of ", "village of ", "state of ", "police department", "sheriff's office", "housing authority", "water district", "sanitation district", "metropolitan district", "library district", "transit authority", "port authority", "public utility district", "department of "] },
];

export function importBlockReason(industry: string | null | undefined, name: string | null | undefined): string | null {
  const hay = `${industry ?? ""} ${name ?? ""}`.toLowerCase();
  // Known brand-name false friend: "City of Angels …" (LA nickname) is a private
  // business pattern, not a municipality (found via "City of Angels Driving School").
  if (hay.includes("city of angels")) return null;
  for (const rule of IMPORT_BLOCK_RULES) {
    if (rule.needles.some((n) => hay.includes(n))) return rule.reason;
  }
  return null;
}

export const SUBINDUSTRIES_BY_BUCKET = {
  "Media / Advertising / Publishing": [
    "Advertising & Marketing",
    "Multimedia & Graphic Design",
    "Broadcasting",
    "Media & Internet",
    "Music Production & Services",
    "Newspapers & News Services",
    "Publishing",
    "Social Networks",
  ],
  "Business Services": [
    "Business Services",
    "Facilities Management & Commercial Cleaning",
    "HR & Staffing",
    "Information & Document Management",
    "Translation & Linguistic Services",
    "Law Firms & Legal Services", // un-blocked 2026-07-02 — prospectable again
  ],
  Consulting: ["Management Consulting"],
  "Transportation / Logistics": [
    "Car & Truck Rental",
    "Airlines, Airports & Air Services",
    "Freight & Logistics Services",
    "Marine Shipping & Transportation",
    "Rail, Bus & Taxi",
    "Transportation",
    "Trucking, Moving & Storage",
  ],
} as const;

export const BUCKETS = Object.keys(SUBINDUSTRIES_BY_BUCKET) as (keyof typeof SUBINDUSTRIES_BY_BUCKET)[];

export const SUBINDUSTRIES: string[] = Object.values(SUBINDUSTRIES_BY_BUCKET).flat();

export const SUBINDUSTRY_SET = new Set(SUBINDUSTRIES);

export function bucketForSubindustry(sub: string): string | null {
  for (const [bucket, subs] of Object.entries(SUBINDUSTRIES_BY_BUCKET)) {
    if ((subs as readonly string[]).includes(sub)) return bucket;
  }
  return null;
}

/** 32 territory regions: 25 US states + 5 Canadian + 2 US territories. */
export const TERRITORY_STATES: string[] = [
  "CA", "AZ", "CO", "WA", "MN", "UT", "OR", "NV", "OK", "KS", "ID", "NE",
  "NM", "WY", "HI", "AK", "MT", "SD", "ND", "TX", "IL", "MO", "WI", "IA", "AR",
  "BC", "AB", "YT", "NT", "NU", // Canada
  "GU", "PR", // US territories
];

export const TERRITORY_STATE_SET = new Set(TERRITORY_STATES);

/**
 * Per-subindustry pain/trigger keywords used across job-post + news scans and
 * to help the LLM judge whether a signal is `subindustry_relevant` (vertical
 * pain) vs generic growth. The mentor's rule: vertical-specific signals
 * outrank generic growth.
 */
export const SIGNAL_KEYWORDS = {
  generic: [
    "QuickBooks", "NetSuite", "ERP", "revenue recognition", "ASC 606",
    "month-end close", "multi-entity", "consolidations", "project accounting",
    "PSA", "utilization", "billing", "FP&A", "Controller", "CFO", "VP Finance",
    "Accounting Manager",
  ],
  "Business Services": [
    "client complexity", "project accounting", "multi-location", "time & expense",
    "billing", "rev rec", "close", "reporting", "multi-entity", "service line",
    "new practice", "boutique acquisition", "subcontractor", "global delivery",
  ],
  Consulting: ["utilization", "project accounting", "PSA", "time & expense", "billing"],
  "Transportation / Logistics": [
    "TMS", "WMS", "dispatch", "settlements", "fleet", "inventory",
    "new lane", "new warehouse", "multi-location", "fleet maintenance",
  ],
  "Media / Advertising / Publishing": [
    "project/job costing", "multi-entity consolidation", "ASC 606", "retainers",
    "licensing", "holdco", "AOR win", "new client", "traffic", "billing",
  ],
} as const;
