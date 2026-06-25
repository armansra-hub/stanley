import "server-only";
import type { Candidate } from "@/lib/ingest/types";
import { getTerritoryConfig } from "@/lib/db/companies";

/**
 * USASpending.gov adapter (FREE, no auth). Recent federal "new award" contracts
 * to recipients in the territory verticals. We query a few random territory
 * states per run (recipient_locations filtered to one state at a time) and tag
 * each result with that state — so the displayed state is the recipient's HQ
 * state, not the place of performance. gov_contract signal; geo-verifiable.
 */
const NAICS_PREFIXES = [
  "5411", "5412", "5414", "5416", "5418", "5419",
  "5611", "5612", "5613", "5614", "5617",
  "48", "49", "51",
];
const CANADIAN = new Set(["BC", "AB", "YT", "NT", "NU", "ON", "QC", "MB", "SK", "NS", "NB", "NL", "PE"]);

export async function fetchUsaSpendingCandidates(
  opts: { lookbackDays?: number; perState?: number; states?: number } = {},
): Promise<Candidate[]> {
  const lookbackDays = opts.lookbackDays ?? 90;
  const perState = opts.perState ?? 8;
  const numStates = opts.states ?? 3;

  const { states } = await getTerritoryConfig();
  const usStates = states.filter((s) => /^[A-Z]{2}$/.test(s) && !CANADIAN.has(s));
  if (usStates.length === 0) return [];
  const picked = [...usStates].sort(() => Math.random() - 0.5).slice(0, numStates);

  const end = new Date();
  const start = new Date(end.getTime() - lookbackDays * 86400000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const out: Candidate[] = [];
  for (const st of picked) {
    const body = {
      filters: {
        award_type_codes: ["A", "B", "C", "D"],
        time_period: [{ start_date: fmt(start), end_date: fmt(end), date_type: "new_awards_only" }],
        recipient_locations: [{ country: "USA", state: st }],
        naics_codes: NAICS_PREFIXES,
      },
      fields: ["Recipient Name", "Award Amount", "Start Date", "Awarding Agency", "generated_internal_id", "NAICS"],
      page: 1,
      limit: perState,
      sort: "Award Amount",
      order: "desc",
    };
    try {
      const res = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) continue;
      const data = await res.json();
      for (const r of data.results ?? []) {
        const name = String(r["Recipient Name"] ?? "").trim();
        const id = r.generated_internal_id;
        if (!name || !id) continue;
        const amount = r["Award Amount"];
        const amt = typeof amount === "number" ? `$${Math.round(amount).toLocaleString()}` : "an undisclosed amount";
        const naics = r.NAICS ? `NAICS ${r.NAICS.code} ${r.NAICS.description}` : "";
        out.push({
          name,
          state: st, // recipient HQ state (filtered)
          source: "discovered",
          sources: ["usaspending"],
          signals: [
            {
              source_name: "USASpending.gov",
              source_url: `https://www.usaspending.gov/award/${id}`,
              raw_excerpt: `Won a ${amt} federal contract from the ${r["Awarding Agency"]} (${naics}); start date ${r["Start Date"]}.`,
            },
          ],
        });
      }
    } catch {
      // isolated: skip this state on error
    }
  }
  return out;
}
