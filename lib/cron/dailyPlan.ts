/** Vercel parent-cron safety ceiling. The active plan intentionally stays below it. */
export const DAILY_CHILD_REQUEST_LIMIT = 65;
export const DAILY_PLANNED_CHILDREN = 52;

/**
 * Foundation receipts measured ordinary USAspending/SAM batches at ten companies.
 * Evidence retained under stanley-public-growth/.foundation-run on 2026-08-03:
 * usaspending-foundation-0.jsonl reported 244 matched checks,
 * usaspending-subawards-foundation-0.jsonl reported 222 matches, and
 * sam-extract-foundation.json reported 3,560 matched UEI-linked companies.
 * The rounded 250 USA baseline is deliberately conservative. One bounded request
 * per day therefore targets a 25-day federal-award cycle and a 356-day SAM-
 * registration cycle for that measured verified population.
 *
 * This recurrence does not discover a newly linked company. Full-TAM discovery
 * and foundation refresh remain a separate, explicit-offset operation with their
 * own deliberate cadence; the daily plan only revisits already verified identities.
 */
export const PUBLIC_GROWTH_RECURRING_COVERAGE = [
  {
    source: "usaspending",
    path: "/api/cron/public-growth?source=usaspending&scope=verified&n=10",
    foundationEligibleBaseline: 250,
    batchSize: 10,
    targetCycleDays: 25,
  },
  {
    source: "usaspending-subawards",
    path: "/api/cron/public-growth?source=usaspending-subawards&scope=verified&n=10",
    foundationEligibleBaseline: 250,
    batchSize: 10,
    targetCycleDays: 25,
  },
  {
    source: "sam-entity",
    path: "/api/cron/public-growth?source=sam-entity&scope=verified&n=10",
    foundationEligibleBaseline: 3_560,
    batchSize: 10,
    targetCycleDays: 356,
  },
] as const;

const PUBLIC_GROWTH_PATHS = [
  ...PUBLIC_GROWTH_RECURRING_COVERAGE.map((target) => target.path),
  "/api/cron/public-growth?source=sam-opportunities&days=31&limit=500",
  "/api/cron/public-growth?source=revenue&n=10&limit=250",
] as const;

/**
 * Only routes with an authenticated GET handler belong in the Vercel parent cron.
 * Form 5500, SAM extract, and SBA loan ingestion require POSTed observations and
 * are deliberately absent.
 */
export const DAILY_GET_ROUTE_PREFIXES = [
  "/api/cron/tal-news",
  "/api/cron/triggers",
  "/api/cron/fmcsa",
  "/api/cron/website",
  "/api/cron/cosos",
  "/api/cron/ats",
  "/api/cron/signals",
  "/api/cron/public-growth",
  "/api/cron/reconcile-hidden",
  "/api/cron/recompute",
] as const;

export function isGetCompatibleDailyPath(path: string): boolean {
  const pathname = new URL(path, "https://stanley.local").pathname;
  return DAILY_GET_ROUTE_PREFIXES.includes(pathname as (typeof DAILY_GET_ROUTE_PREFIXES)[number]);
}

/** Pure, deterministic manifest for the one Vercel daily cron. */
export function buildDailyWavePaths(_dayIndex?: number): string[] {
  const TRIGGER_WAVES = 20, TRIGGER_N = 250;
  const FMCSA_WAVES = 3, FMCSA_N = 200;
  const SITE_N = 30;

  // Every public-growth cursor advances once per day. The lease fence rejects an
  // overlapping invocation instead of allowing parallel waves to share a cursor.
  const paths = [
    "/api/cron/tal-news",
    ...Array.from({ length: TRIGGER_WAVES }, (_, k) => `/api/cron/triggers?n=${TRIGGER_N}&wave=${k}`),
    ...Array.from({ length: FMCSA_WAVES }, (_, k) => `/api/cron/fmcsa?n=${FMCSA_N}&wave=${k}`),
    // Capacity tradeoff: three 30-site claimable waves fund the three additional
    // daily public-growth sources (website claimable volume is 480 -> 390/day).
    ...Array.from({ length: 13 }, (_, k) => `/api/cron/website?n=${SITE_N}&wave=${k}`),
    ...Array.from({ length: 4 }, (_, k) => `/api/cron/website?n=${SITE_N}&scope=tail&wave=${k}`),
    ...Array.from({ length: 2 }, (_, k) => `/api/cron/cosos?n=200&wave=${k}`),
    "/api/cron/ats?n=200",
    "/api/cron/signals?n=250",
    ...PUBLIC_GROWTH_PATHS,
    "/api/cron/reconcile-hidden",
    "/api/cron/recompute",
  ];
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error("daily cron plan contains duplicate child requests");
  if (unique.length !== DAILY_PLANNED_CHILDREN) {
    throw new Error(`daily cron plan expected ${DAILY_PLANNED_CHILDREN} child requests, received ${unique.length}`);
  }
  if (unique.length > DAILY_CHILD_REQUEST_LIMIT) {
    throw new Error(`daily cron plan exceeds ${DAILY_CHILD_REQUEST_LIMIT} child requests`);
  }
  const incompatible = unique.filter((path) => !isGetCompatibleDailyPath(path));
  if (incompatible.length) throw new Error(`daily cron plan contains non-GET routes: ${incompatible.join(", ")}`);
  return unique;
}
