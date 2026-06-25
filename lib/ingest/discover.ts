import "server-only";
import { ingestCandidates, type IngestResult } from "./orchestrator";
import { fetchGoogleNewsCandidates } from "@/lib/sources/googleNews";
import { fetchUsaSpendingCandidates } from "@/lib/sources/usaspending";
import { fetchEdgarFormDCandidates } from "@/lib/sources/edgarFormD";
import { fetchFmcsaCandidates } from "@/lib/sources/fmcsa";
import { fetchPressReleaseCandidates } from "@/lib/sources/pressRss";
import { DISCOVERY_QUERIES } from "@/config/news";
import type { Candidate } from "./types";

export const FREE_SOURCE_IDS = ["news", "usaspending", "fmcsa", "press", "edgar"] as const;

export interface DiscoveryResult extends IngestResult {
  sources: string[];
  fetched_by_source: Record<string, number>;
  fetched: number;
}

/** Run the requested FREE sources (or "all") through the shared pipeline. */
export async function runFreeDiscovery(sources: string[]): Promise<DiscoveryResult> {
  const want = (s: string) => sources.includes("all") || sources.includes(s);
  const candidates: Candidate[] = [];
  const fetched_by_source: Record<string, number> = {};
  const ran: string[] = [];

  const add = async (id: string, fn: () => Promise<Candidate[]>) => {
    if (!want(id)) return;
    const c = await fn();
    candidates.push(...c);
    fetched_by_source[id] = c.length;
    ran.push(id);
  };

  await add("news", () => fetchGoogleNewsCandidates(DISCOVERY_QUERIES, 2, 40));
  await add("usaspending", () => fetchUsaSpendingCandidates({ perState: 6, states: 3 }));
  await add("fmcsa", () => fetchFmcsaCandidates({ limit: 12 }));
  await add("press", () => fetchPressReleaseCandidates(6));
  await add("edgar", () => fetchEdgarFormDCandidates(8));

  const result = await ingestCandidates(candidates);
  return { sources: ran, fetched_by_source, fetched: candidates.length, ...result };
}
