/** Pure, testable manifest for the one Vercel daily cron. */
export const DAILY_CHILD_REQUEST_LIMIT = 66;

export function buildDailyWavePaths(): string[] {
  // The classifier is now deduped, retry-free, and concurrency-safe. That makes a
  // 250-company news wave safe while keeping the same nominal 5,000/day coverage
  // with five fewer serverless invocations than the old 25 x 200 plan.
  const TRIGGER_WAVES = 20, TRIGGER_N = 250;
  const FMCSA_WAVES = 4, FMCSA_N = 150;
  const SITE_N = 30;

  const paths = [
    "/api/cron/tal-news",
    ...Array.from({ length: TRIGGER_WAVES }, (_, k) => `/api/cron/triggers?n=${TRIGGER_N}&offset=${k * TRIGGER_N}`),
    ...Array.from({ length: FMCSA_WAVES }, (_, k) => `/api/cron/fmcsa?n=${FMCSA_N}&offset=${k * FMCSA_N}`),
    ...Array.from({ length: 24 }, (_, k) => `/api/cron/website?n=${SITE_N}&offset=${k * SITE_N}`),
    ...Array.from({ length: 12 }, (_, k) => `/api/cron/website?n=${SITE_N}&offset=${k * SITE_N}&scope=tail`),
    ...Array.from({ length: 4 }, (_, k) => `/api/cron/cosos?n=200&offset=${k * 200}`),
    "/api/cron/recompute",
  ];
  const unique = [...new Set(paths)];
  if (unique.length !== paths.length) throw new Error("daily cron plan contains duplicate child requests");
  if (unique.length > DAILY_CHILD_REQUEST_LIMIT) {
    throw new Error(`daily cron plan exceeds ${DAILY_CHILD_REQUEST_LIMIT} child requests`);
  }
  return unique;
}
