import "server-only";
import { ingestCandidates, type IngestResult } from "./orchestrator";
import { ACTORS } from "@/config/actors";
import { fetchGoogleMapsCandidates } from "@/lib/sources/googleMaps";
import {
  fetchIndeedCandidates,
  fetchGoogleJobsCandidates,
  fetchLinkedinJobsCandidates,
  fetchCareerSitesCandidates,
  fetchLinkedinPostsCandidates,
  fetchLeadsFinderCandidates,
  fetchSalesNavCandidates,
  fetchBuiltinCandidates,
} from "@/lib/sources/apifyAdapters";
import { getActorOverrides } from "@/lib/db/settings";
import type { Candidate } from "./types";

/**
 * PAID Apify discovery — kept separate from the free auto-refresh so the
 * pay-per-result actors run only when explicitly triggered (with caps). All 9
 * actors are wired; `?actors=all` runs only the ones enabled in the registry
 * (config/actors.ts), but any actor can be run by name (e.g. ?actors=builtin_jobs).
 */
type AdapterFn = () => Promise<Candidate[]>;

const ADAPTERS: Record<string, AdapterFn> = {
  google_maps: () => fetchGoogleMapsCandidates(),
  indeed: () => fetchIndeedCandidates(),
  google_jobs: () => fetchGoogleJobsCandidates(),
  linkedin_jobs: () => fetchLinkedinJobsCandidates(),
  career_sites: () => fetchCareerSitesCandidates(),
  linkedin_posts: () => fetchLinkedinPostsCandidates(),
  leads_finder: () => fetchLeadsFinderCandidates(),
  sales_nav: () => fetchSalesNavCandidates(),
  builtin_jobs: () => fetchBuiltinCandidates(),
};

export interface ApifyDiscoveryResult extends IngestResult {
  sources: string[];
  fetched_by_source: Record<string, number | string>;
  fetched: number;
}

export async function runApifyDiscovery(keys: string[]): Promise<ApifyDiscoveryResult> {
  let wanted = keys;
  if (keys.includes("all")) {
    const overrides = await getActorOverrides();
    wanted = Object.entries(ACTORS)
      .filter(([k, a]) => (overrides[k]?.enabled ?? a.enabled) && k in ADAPTERS)
      .map(([k]) => k);
  }
  const candidates: Candidate[] = [];
  const fetched_by_source: Record<string, number | string> = {};

  for (const k of wanted) {
    const fn = ADAPTERS[k];
    if (!fn) {
      fetched_by_source[k] = "not wired yet";
      continue;
    }
    try {
      const c = await fn();
      candidates.push(...c);
      fetched_by_source[k] = c.length;
    } catch (e) {
      fetched_by_source[k] = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  const result = await ingestCandidates(candidates);
  return { sources: Object.keys(fetched_by_source), fetched_by_source, fetched: candidates.length, ...result };
}
