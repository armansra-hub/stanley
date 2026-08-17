/** Vercel parent-cron safety ceiling. The active plan intentionally stays below it. */
export const DAILY_CHILD_REQUEST_LIMIT = 65;
export const DAILY_PLANNED_CHILDREN = 60;

/**
 * Foundation receipts measured ordinary SAM/subaward batches at ten companies.
 * Award-history continuation is bounded to one USAspending company per request.
 * Evidence retained under stanley-public-growth/.foundation-run on 2026-08-03:
 * usaspending-foundation-0.jsonl reported 244 matched checks,
 * usaspending-subawards-foundation-0.jsonl reported 222 matches, and
 * sam-extract-foundation.json reported 3,560 matched UEI-linked companies.
 * The rounded 250 USA baseline is deliberately conservative. One bounded request
 * Federal award detail is the slow exception: one recipient can fan out across
 * hundreds of awards and transaction pages. Raise it conservatively to three
 * verified recipients/day. Subawards are lighter and now cover the verified
 * baseline inside one week. SAM entity lookups remain capped by SAM API access;
 * the monthly bulk extract is the high-volume path.
 *
 * This recurrence does not discover a newly linked company. Full-TAM discovery
 * and foundation refresh remain a separate, explicit-offset operation with their
 * own deliberate cadence; the daily plan only revisits already verified identities.
 */
export const PUBLIC_GROWTH_RECURRING_COVERAGE = [
  {
    source: "usaspending",
    path: "/api/cron/public-growth?source=usaspending&scope=verified&n=3",
    foundationEligibleBaseline: 250,
    batchSize: 3,
    targetCycleDays: 84,
  },
  {
    source: "usaspending-subawards",
    path: "/api/cron/public-growth?source=usaspending-subawards&scope=verified&n=50",
    foundationEligibleBaseline: 250,
    batchSize: 50,
    targetCycleDays: 5,
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
  "/api/cron/public-growth?source=sam-opportunities&days=31&limit=1000",
  "/api/cron/public-growth?source=revenue&n=10&limit=1000",
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
  const TRIGGER_WAVES = 9, TRIGGER_N = 600;
  const FMCSA_WAVES = 10, FMCSA_N = 250;
  const SITE_WAVES = 13, SITE_N = 200;
  const SOS_WAVES = 7, SOS_N = 400;
  const ATS_WAVES = 13, ATS_N = 200;

  // Every public-growth cursor advances once per day. The lease fence rejects an
  // overlapping invocation instead of allowing parallel waves to share a cursor.
  const paths = [
    "/api/cron/tal-news",
    ...Array.from({ length: TRIGGER_WAVES }, (_, k) => `/api/cron/triggers?n=${TRIGGER_N}&wave=${k}`),
    ...Array.from({ length: FMCSA_WAVES }, (_, k) => `/api/cron/fmcsa?n=${FMCSA_N}&wave=${k}`),
    // Capacity tradeoff against the deployed 24-wave plan: website claimable
    // volume is 720 -> 390/day, funding recurring public-growth and ATS work.
    ...Array.from({ length: SITE_WAVES }, (_, k) => `/api/cron/website?n=${SITE_N}&wave=${k}`),
    ...Array.from({ length: SOS_WAVES }, (_, k) => `/api/cron/cosos?n=${SOS_N}&wave=${k}`),
    ...Array.from({ length: ATS_WAVES }, (_, k) => `/api/cron/ats?n=${ATS_N}&wave=${k}`),
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
