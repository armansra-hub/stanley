import "server-only";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * SEC EDGAR full-text search — FREE (requires a descriptive User-Agent per SEC
 * policy). Recent Form D filings = a private capital raise (Reg D exempt offering).
 * Searched by company name; the caller verifies the filer name actually matches.
 */
export interface EdgarHit { name: string; date: string | null; form: string }

export async function fetchEdgarFunding(name: string, sinceDays = 180, max = 5): Promise<EdgarHit[]> {
  try {
    const start = new Date(Date.now() - sinceDays * 86_400_000).toISOString().slice(0, 10);
    const end = new Date().toISOString().slice(0, 10);
    const q = encodeURIComponent(`"${name}"`);
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 9000);
    const r = await fetch(`https://efts.sec.gov/LATEST/search-index?q=${q}&forms=D&startdt=${start}&enddt=${end}`, {
      signal: ctl.signal,
      headers: { "user-agent": "StanleyTAM research armansra@gmail.com", accept: "application/json" },
    });
    clearTimeout(to);
    if (!r.ok) return [];
    const d = await r.json();
    const hits = d?.hits?.hits ?? [];
    return hits.slice(0, max).map((x: any) => ({
      name: Array.isArray(x._source?.display_names) ? String(x._source.display_names[0] ?? "") : "",
      date: x._source?.file_date ?? null,
      form: Array.isArray(x._source?.root_forms) ? String(x._source.root_forms[0] ?? "D") : "D",
    }));
  } catch { return []; }
}
