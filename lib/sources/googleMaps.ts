import "server-only";
import { runActor } from "@/lib/apify/run";
import { getTerritoryConfig } from "@/lib/db/companies";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Google Maps (compass/crawler-google-places) — PAID discovery (~$0.004/place).
 * SMB long-tail discovery by category + geography. The ONLY source whose
 * location is verifiable, so it's the geo-hard-filtered one: we search WITHIN a
 * territory state and tag every result to that state. Returns real WEBSITES →
 * SQL-exportable. A random state + shuffled category terms vary coverage each run.
 */
const ACTOR = "compass/crawler-google-places";

const SEARCH_TERMS = [
  "accounting firm", "CPA firm", "staffing agency", "management consulting firm",
  "commercial cleaning company", "facilities services", "law firm", "advertising agency",
  "marketing agency", "document management company", "trucking company", "freight company",
  "logistics company", "moving company", "courier service",
];

// territory code → Google Maps locationQuery
const LOC: Record<string, string> = {
  CA: "California, USA", AZ: "Arizona, USA", CO: "Colorado, USA", WA: "Washington, USA",
  MN: "Minnesota, USA", UT: "Utah, USA", OR: "Oregon, USA", NV: "Nevada, USA",
  OK: "Oklahoma, USA", KS: "Kansas, USA", ID: "Idaho, USA", NE: "Nebraska, USA",
  NM: "New Mexico, USA", WY: "Wyoming, USA", HI: "Hawaii, USA", AK: "Alaska, USA",
  MT: "Montana, USA", SD: "South Dakota, USA", ND: "North Dakota, USA", TX: "Texas, USA",
  IL: "Illinois, USA", MO: "Missouri, USA", WI: "Wisconsin, USA", IA: "Iowa, USA",
  AR: "Arkansas, USA", PR: "Puerto Rico", GU: "Guam",
  BC: "British Columbia, Canada", AB: "Alberta, Canada", YT: "Yukon, Canada",
  NT: "Northwest Territories, Canada", NU: "Nunavut, Canada",
};

function shuffle<T>(a: T[]): T[] {
  return [...a].sort(() => Math.random() - 0.5);
}

export async function fetchGoogleMapsCandidates(
  opts: { terms?: number; perSearch?: number; maxItems?: number; state?: string } = {},
): Promise<Candidate[]> {
  const { states } = await getTerritoryConfig();
  const codes = states.filter((s) => LOC[s]);
  if (codes.length === 0) return [];
  const code = opts.state && LOC[opts.state] ? opts.state : codes[Math.floor(Math.random() * codes.length)];
  const terms = shuffle(SEARCH_TERMS).slice(0, opts.terms ?? 4);

  const items = await runActor(
    ACTOR,
    {
      searchStringsArray: terms,
      locationQuery: LOC[code],
      maxCrawledPlacesPerSearch: opts.perSearch ?? 6,
      language: "en",
      skipClosedPlaces: true,
    },
    opts.maxItems ?? 24,
  );

  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.title ?? "").trim();
    if (!name) continue;
    const website = typeof r.website === "string" && r.website ? r.website : undefined;
    const category = (r.categoryName as string) ?? "";
    const city = (r.city as string) ?? null;
    out.push({
      name,
      website,
      state: code, // searched within this territory state (geo hard filter)
      city,
      source: "discovered",
      sources: ["google_maps"],
      signals: [
        {
          source_name: "Google Maps",
          source_url: (r.url as string) || website || "https://maps.google.com",
          raw_excerpt: `${name} — ${category}${city ? ` in ${city}, ${code}` : ""} (in-territory business found via Google Maps).`,
        },
      ],
    });
  }
  return out;
}
