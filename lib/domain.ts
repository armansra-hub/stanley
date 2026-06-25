/**
 * Domain normalization — the single source of truth for both the dedupe key
 * and the domains placed into the NetSuite SQL export, so they match exactly
 * what NetSuite computes in the saved-search formula.
 *
 * Rule (must mirror the SQL REGEXP_REPLACE chain in lib/export/sql.ts):
 *   lowercase -> trim -> strip leading "https://" / "http://"
 *   -> strip leading "www." -> strip everything from the first "/", "?", or "#"
 */
export function normalizeDomain(url: string | null | undefined): string {
  let s = (url ?? "").trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/^www\./, "");
  s = s.replace(/[/?#].*$/, "");
  return s;
}

/**
 * Normalize + dedupe a list of URLs into unique normalized domains,
 * dropping empties and preserving first-seen order.
 */
export function uniqueNormalizedDomains(urls: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    const d = normalizeDomain(u);
    if (d && !seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}
