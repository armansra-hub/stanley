import { createHash } from "node:crypto";

export type RevisitOutcome = "baseline" | "changed" | "quiet" | "incomplete";
export type RevisitHistory = {
  version: 1; quietRuns: number; intervalHours: number; outcome: RevisitOutcome;
  nextDueAt: string; lastChangedAt: string | null;
};

const quietIntervals = [1, 2, 4, 8, 24];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Only completed, comparable scans earn a longer interval. Partial pages and
 * errors retain the last quiet count without presenting a successful quiet scan. */
export function nextRevisit(previous: unknown, outcome: RevisitOutcome, now = new Date()): RevisitHistory {
  const prior = record(previous);
  const previousQuiet = prior.version === 1 && Number.isInteger(prior.quietRuns)
    ? Math.max(0, Math.min(4, Number(prior.quietRuns))) : 0;
  const quietRuns = outcome === "quiet" ? Math.min(4, previousQuiet + 1)
    : outcome === "incomplete" ? previousQuiet : 0;
  const intervalHours = outcome === "quiet" ? quietIntervals[quietRuns] : 1;
  return {
    version: 1, quietRuns, intervalHours, outcome,
    nextDueAt: new Date(now.getTime() + intervalHours * 3_600_000).toISOString(),
    lastChangedAt: outcome === "changed" ? now.toISOString()
      : typeof prior.lastChangedAt === "string" && Number.isFinite(Date.parse(prior.lastChangedAt)) ? prior.lastChangedAt : null,
  };
}

/** Hash URL keys instead of storing another duplicate URL inventory. Discovery
 * rotates pages, so compare every fetched page against its own previous content,
 * never compare hashes of two differently sized page batches. */
export function websiteChangeHistory(previous: unknown, pages: { url: string; contentHash: string }[]) {
  const prior = record(previous);
  const hashes: Record<string, string> = Object.fromEntries(Object.entries(prior)
    .filter(([key, value]) => /^[a-f0-9]{64}$/.test(key) && typeof value === "string" && value.length <= 128).slice(-200)) as Record<string, string>;
  const baseline = Object.keys(hashes).length === 0;
  let changed = false;
  for (const page of pages) {
    if (!page.contentHash) continue;
    const key = createHash("sha256").update(page.url).digest("hex");
    if (!baseline && hashes[key] !== page.contentHash) changed = true;
    // Refreshed keys go last so the bounded cache retains recently visited pages.
    delete hashes[key]; hashes[key] = page.contentHash;
  }
  return { hashes: Object.fromEntries(Object.entries(hashes).slice(-200)), outcome: baseline ? "baseline" as const : changed ? "changed" as const : "quiet" as const };
}

/** ATS lifecycle summaries cover the whole board, including expirations. A
 * missing summary cannot establish quiet history even if a caller says done. */
export function atsRevisitOutcome(complete: boolean, summary?: {
  baseline: boolean; newJobs: number; changedJobs: number; reopenedJobs: number; expiredJobs: number;
}): RevisitOutcome {
  if (!complete || !summary) return "incomplete";
  if (summary.baseline) return "baseline";
  const changes = [summary.newJobs, summary.changedJobs, summary.reopenedJobs, summary.expiredJobs];
  if (changes.some(count => !Number.isFinite(count) || count < 0)) return "incomplete";
  return changes.some(count => count > 0) ? "changed" : "quiet";
}
