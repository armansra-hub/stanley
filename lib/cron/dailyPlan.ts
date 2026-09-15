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
 * hours. Subawards allocate that baseline in two 16-hour invocations. Prime awards
 * additionally service one retry; subawards service up to ten within a separate
 * 60-second retry budget. Main pages continue within the remaining request budget.
 * These are explicit eligible-set budgets, not full-TAM discovery or proof that
 * every deep history completed; source receipts retain continuation debt.
 * SAM entity
 * API lookups are not scheduled because they cannot succeed without a key; the
 * official monthly public extract remains the keyless high-volume source.
 *
 * This recurrence does not discover a newly linked company. Full-TAM discovery
 * and foundation refresh remain a separate, explicit-offset operation with their
 * own deliberate cadence; the daily plan only revisits already verified identities.
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
    invocationsPerRotation: 1,
    rotationHours: 16,
    targetCycleHours: 32,
  },
] as const;

const PUBLIC_GROWTH_PATHS = [
  PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "usaspending-subawards")!.path,
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
  const TRIGGER_WAVES = 7, TRIGGER_N = 500;
  const FMCSA_WAVES = 4, FMCSA_N = 250;
  const SITE_WAVES = 15, SITE_N = 250;
  const SOS_WAVES = 1, SOS_N = 400;
  const ATS_WAVES = 15, ATS_N = 250;

  const ordinaryPaths = [
    "/api/cron/tal-news",
    ...Array.from({ length: TRIGGER_WAVES }, (_, k) => `/api/cron/triggers?n=${TRIGGER_N}&wave=${k}`),
    ...Array.from({ length: FMCSA_WAVES }, (_, k) => `/api/cron/fmcsa?n=${FMCSA_N}&wave=${k}`),
    // The 16-hour manifest repeats three times in 48 hours. News plans 10,500
    // checks and website/ATS each plan 11,250, leaving missed-wave margin above
    // the current 7,441-company TAM. Actual completed checks remain bounded by
    // each worker's time budget and must be read from its receipts.
    ...Array.from({ length: SITE_WAVES }, (_, k) => `/api/cron/website?n=${SITE_N}&wave=${k}`),
    ...Array.from({ length: SOS_WAVES }, (_, k) => `/api/cron/cosos?n=${SOS_N}&wave=${k}`),
    ...Array.from({ length: ATS_WAVES }, (_, k) => `/api/cron/ats?n=${ATS_N}&wave=${k}`),
    ...PUBLIC_GROWTH_PATHS,
    "/api/cron/reconcile-hidden",
    "/api/cron/recompute",
  ];
  if (ordinaryPaths.length !== 48) throw new Error(`daily cron expected 48 ordinary paths, received ${ordinaryPaths.length}`);

  // Prime awards and candidate verification run in every hourly stage. This
  // prevents same-source lease collisions, removes the manual review backlog,
  // and leaves three slots for continuous broad-source rotation.
  const prime = PUBLIC_GROWTH_RECURRING_COVERAGE.find((target) => target.source === "usaspending")!;
  const paths = Array.from({ length: 16 }, (_, stage) => [
    `${prime.path}&wave=${stage}`,
    `/api/cron/review-candidates?n=25&wave=${stage}`,
    ...ordinaryPaths.slice(stage * 3, stage * 3 + 3),
  ]).flat();
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
