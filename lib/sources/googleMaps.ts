import "server-only";
import { runActor } from "@/lib/apify/run";
import { nextSlices, recordSlice } from "@/lib/ingest/coverage";
import { TERRITORY_CITIES, MAPS_CATEGORIES } from "@/config/coverage";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Google Maps (compass) — PAID SMB discovery (~$0.004/place). Systematically
 * sweeps city × subindustry-category via the coverage round-robin, so every run
 * hits a NEW (city, category) slice (no duplicate spend). Returns real WEBSITES
 * and tags the city's state (geo-verified).
 */
export async function fetchGoogleMapsCandidates(
  opts: { slices?: number; perSearch?: number } = {},
): Promise<Candidate[]> {
  const universe = TERRITORY_CITIES.flatMap((c) => MAPS_CATEGORIES.map((cat) => `${c}::${cat}`));
  const slices = await nextSlices("google_maps", universe, opts.slices ?? 4);
  const perSearch = opts.perSearch ?? 8;

  const out: Candidate[] = [];
  for (const slice of slices) {
    const [city, category] = slice.split("::");
    const st = (city.split(",")[1] || "").trim();
    try {
      const items = await runActor(
        "compass/crawler-google-places",
        { searchStringsArray: [category], locationQuery: city, maxCrawledPlacesPerSearch: perSearch, language: "en", skipClosedPlaces: true },
        perSearch,
      );
      let kept = 0;
      for (const r of items) {
        const name = String(r.title ?? "").trim();
        if (!name) continue;
        out.push({
          name,
          website: typeof r.website === "string" && r.website ? r.website : undefined,
          state: st || null,
          city: (r.city as string) ?? null,
          source: "discovered",
          sources: ["google_maps"],
          signals: [
            {
              source_name: "Google Maps",
              source_url: (r.url as string) || (r.website as string) || "https://maps.google.com",
              raw_excerpt: `${name} — ${r.categoryName || category}${r.city ? ` in ${r.city}, ${st}` : ""} (in-territory SMB found via Google Maps).`,
            },
          ],
        });
        kept++;
      }
      await recordSlice("google_maps", slice, kept);
    } catch {
      await recordSlice("google_maps", slice, 0);
    }
  }
  return out;
}
