import "server-only";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * USAspending.gov — FREE, keyless. Recent FEDERAL CONTRACT awards for a recipient.
 * A new award is a revenue step-change (and audit/DCAA exposure) → ERP pressure.
 * Searched by recipient name; the caller verifies the name actually matches.
 */
export interface GovAward { recipient: string; amount: number; date: string | null; description: string; agency: string; id: string }

export async function fetchGovAwards(name: string, sinceDays = 150, max = 5): Promise<GovAward[]> {
  try {
    const start = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 120 * 86_400_000).toISOString().slice(0, 10); // awards can carry a future start date
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch("https://api.usaspending.gov/api/v2/search/spending_by_award/", {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filters: { recipient_search_text: [name], award_type_codes: ["A", "B", "C", "D"], time_period: [{ start_date: start, end_date: end }] },
        fields: ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Description", "Start Date"],
        limit: max, sort: "Start Date", order: "desc",
      }),
    });
    clearTimeout(to);
    if (!r.ok) return [];
    const d = await r.json();
    return (d.results ?? []).map((x: any) => ({
      recipient: String(x["Recipient Name"] ?? ""),
      amount: Number(x["Award Amount"] ?? 0),
      date: x["Start Date"] ?? null,
      description: String(x["Description"] ?? ""),
      agency: String(x["Awarding Agency"] ?? ""),
      id: String(x.generated_internal_id ?? x["Award ID"] ?? ""),
    }));
  } catch { return []; }
}
