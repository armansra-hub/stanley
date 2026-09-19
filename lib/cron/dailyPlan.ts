/** Vercel parent-cron safety ceiling. */
export const DAILY_CHILD_REQUEST_LIMIT = 80;
export const DAILY_PLANNED_CHILDREN = 80;
export const DAILY_STAGE_SIZE = 5;

/**
 * Foundation receipts measured ordinary SAM/subaward batches at ten companies.
 * Award-history continuation is bounded to one USAspending company per request.
 * Evidence retained under stanley-public-growth/.foundation-run on 2026-08-03:
 * usaspending-foundation-0.jsonl reported 244 matched checks,
 * usaspending-subawards-foundation-0.jsonl reported 222 matches, and
 * sam-extract-foundation.json reported 3,560 matched UEI-linked companies.
 * The rounded 250 USA baseline describes that historical measured scope. A TAM
 * refresh must recount eligible identities after its foundation ingest.
 * Federal award detail is the slow exception: one recipient can fan out across
 * hundreds of awards and transaction pages. Prime-award history now receives
 * one bounded invocation in every hourly stage. Six verified recipients per
 * stage covers that 250-recipient foundation population inside 48
 * hours. Subawards run every two hourly stages. A September source sample admitted
 * only 13 main companies in 242 seconds despite n=125, so the requested batch
 * ceiling cannot be treated as throughput. Eight calls per 16-hour rotation
 * provide 24 opportunities in 48 hours; actual completion and retry debt still
 * require source receipts. Prime awards
 * additionally service one retry; subawards service up to ten within a separate
 * 60-second retry budget. Main pages continue within the remaining request budget.
 * These are explicit eligible-set budgets, not full-TAM discovery or proof that
 * every deep history completed; source receipts retain continuation debt.
 * SAM entity API refresh has a separate small allocation below; the official
 * monthly public extract remains the keyless high-volume source.
 *
 * This hourly recurrence revisits already verified identities. The separate
 * /api/cron/federal-discovery schedule walks current TAM companies without a
 * verified federal recipient/award link every five minutes in bounded batches.
 * It saves identity and one award for enrollment; this plan handles their
 * subsequent award history. Source failures remain explicit checkpoint debt.
 */
export const PUBLIC_GROWTH_RECURRING_COVERAGE = [
  {
    source: "usaspending",
    path: "/api/cron/public-growth?source=usaspending&scope=verified&n=6",
    foundationEligibleBaseline: 250,
    batchSize: 6,
    invocationsPerRotation: 16,
    rotationHours: 16,
    targetCycleHours: 48,
  },
  {
    source: "usaspending-subawards",
    path: "/api/cron/public-growth?source=usaspending-subawards&scope=verified&n=125",
    foundationEligibleBaseline: 250,
    batchSize: 125,
    invocationsPerRotation: 8,
    rotationHours: 16,
    targetCycleHours: 48,
  },
] as const;

/**
 * Supplemental refresh through the existing source lease/cursor, now that the
 * production SAM key is configured. GSA's lowest personal-key entitlement is
 * ten requests/day (https://open.gsa.gov/api/entity-api/). One company page per
 * 16-hour rotation requires at most two entity requests in any 24-hour window;
 * the worker saves pagination/alias continuation for later source invocations.
 * This is not a full-population completion budget or a claim about key quota.
 */
export const SAM_ENTITY_RECURRING_REFRESH = {
  path: "/api/cron/public-growth?source=sam-entity&scope=verified&n=1",
  stage: 15,
  batchSize: 1,
  rotationHours: 16,
} as const;

const PUBLIC_GROWTH_PATHS = [
  "/api/cron/public-growth?source=sam-opportunities&days=31&limit=1000",
  "/api/cron/public-growth?source=revenue&n=10&limit=4000",
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
  "/api/cron/review-candidates",
  "/api/cron/reconcile-hidden",
  "/api/cron/recompute",
] as const;

export function isGetCompatibleDailyPath(path: string): boolean {
  const pathname = new URL(path, "https://stanley.local").pathname;
  return DAILY_GET_ROUTE_PREFIXES.includes(pathname as (typeof DAILY_GET_ROUTE_PREFIXES)[number]);
}

/** Pure, deterministic manifest for the one Vercel daily cron. */
export function buildDailyWavePaths(_dayIndex?: number): string[] {
  const TRIGGER_WAVES = 6, TRIGGER_N = 500;
  const FMCSA_WAVES = 4, FMCSA_N = 250;
  const SITE_WAVES = 12, SITE_N = 250;
  const SOS_WAVES = 1, SOS_N = 400;
  const ATS_WAVES = 12, ATS_N = 250;

  const ordinaryPaths = [
    "/api/cron/tal-news",
    ...Array.from({ length: TRIGGER_WAVES }, (_, k) => `/api/cron/triggers?n=${TRIGGER_N}&wave=${k}`),
    ...Array.from({ length: FMCSA_WAVES }, (_, k) => `/api/cron/fmcsa?n=${FMCSA_N}&wave=${k}`),
    // The 16-hour manifest repeats three times in 48 hours. News, website and
    // ATS each plan 9,000 checks, leaving missed-wave margin above
    // the current 7,441-company TAM. Actual completed checks remain bounded by
    // each worker's time budget and must be read from its receipts.
    ...Array.from({ length: SITE_WAVES }, (_, k) => `/api/cron/website?n=${SITE_N}&wave=${k}`),
    ...Array.from({ length: SOS_WAVES }, (_, k) => `/api/cron/cosos?n=${SOS_N}&wave=${k}`),
    ...Array.from({ length: ATS_WAVES }, (_, k) => `/api/cron/ats?n=${ATS_N}&wave=${k}`),
    ...PUBLIC_GROWTH_PATHS,
    "/api/cron/reconcile-hidden",
    "/api/cron/recompute",
  ];
  if (ordinaryPaths.length !== 40) throw new Error(`daily cron expected 40 ordinary paths, received ${ordinaryPaths.length}`);

  // Prime awards run every hour. Candidate verification retains 15 hourly
  // slots, with one slot assigned to the bounded SAM API supplement. Three
  // slots remain for broad-source rotation; one goes to subawards on alternating
  // stages, including the cyclic stage-14-to-0 gap.
  const prime = PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "usaspending")!;
  const subawards = PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "usaspending-subawards")!;
  let ordinaryOffset = 0;
  const paths = Array.from({ length: 16 }, (_, stage) => {
    const subawardPaths = stage % 2 === 0 ? [`${subawards.path}&wave=${stage / 2}`] : [];
    const count = 3 - subawardPaths.length;
    const ordinary = ordinaryPaths.slice(ordinaryOffset, ordinaryOffset + count);
    ordinaryOffset += count;
    return [
      `${prime.path}&wave=${stage}`,
      stage === SAM_ENTITY_RECURRING_REFRESH.stage
        ? SAM_ENTITY_RECURRING_REFRESH.path
        : `/api/cron/review-candidates?n=25&wave=${stage}`,
      ...subawardPaths,
      ...ordinary,
    ];
  }).flat();
  if (ordinaryOffset !== ordinaryPaths.length) throw new Error("daily cron did not allocate every ordinary path");
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
