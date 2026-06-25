import "server-only";
import { ingestCandidates, type IngestResult } from "./orchestrator";
import { fetchGoogleNewsCandidates } from "@/lib/sources/googleNews";
import { fetchUsaSpendingCandidates } from "@/lib/sources/usaspending";
import { fetchEdgarFormDCandidates } from "@/lib/sources/edgarFormD";
import { fetchFmcsaCandidates } from "@/lib/sources/fmcsa";
import { fetchPressReleaseCandidates } from "@/lib/sources/pressRss";
import { nextSlices, recordSlice } from "./coverage";
import { DISCOVERY_QUERIES } from "@/config/news";
import type { Candidate } from "./types";

export const FREE_SOURCE_IDS = ["news", "usaspending", "fmcsa", "press", "edgar"] as const;

export interface DiscoveryResult extends IngestResult {
  sources: string[];
  fetched_by_source: Record<string, number>;
  fetched: number;
}

/**
 * Run the requested FREE sources (or "all") through the shared pipeline. To stay
 * under the 60s function cap, all sources fetch IN PARALLEL and the news adapter
 * only runs a ROTATING subset of the discovery queries each call (coverage
 * round-robin) instead of hitting every RSS feed every time.
 */
export async function runFreeDiscovery(sources: string[]): Promise<DiscoveryResult> {
  const want = (s: string) => sources.includes("all") || sources.includes(s);
  const fetched_by_source: Record<string, number> = {};
  const ran: string[] = [];
  const buckets: Candidate[][] = [];

  // News: rotate ~12 queries/run so we don't fetch all ~50 feeds every time.
  let newsQueries: string[] = DISCOVERY_QUERIES;
  if (want("news")) {
    const slice = await nextSlices("news_q", DISCOVERY_QUERIES, 12);
    if (slice.length) newsQueries = slice;
  }

  const add = (id: string, fn: () => Promise<Candidate[]>): Promise<void> => {
    if (!want(id)) return Promise.resolve();
    ran.push(id);
    return fn()
      .then((c) => { buckets.push(c); fetched_by_source[id] = c.length; })
      .catch(() => { fetched_by_source[id] = 0; });
  };

  await Promise.all([
    add("news", () => fetchGoogleNewsCandidates(newsQueries, 2, 24)),
    add("usaspending", () => fetchUsaSpendingCandidates({ perState: 5, states: 2 })),
    add("fmcsa", () => fetchFmcsaCandidates({ limit: 10 })),
    add("press", () => fetchPressReleaseCandidates(5)),
    add("edgar", () => fetchEdgarFormDCandidates(6)),
  ]);

  // Advance the news rotation so different queries run next time.
  if (want("news")) await Promise.all(newsQueries.map((q) => recordSlice("news_q", q, 0)));

  const candidates = buckets.flat();
  const result = await ingestCandidates(candidates);
  return { sources: ran, fetched_by_source, fetched: candidates.length, ...result };
}
