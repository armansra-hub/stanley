import { googleNewsRss } from "@/config/news";

const phrase = (value: string) => `"${value.replace(/["\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140)}"`;
/** Pure planning only: no fetch, account enumeration, queue, schedule or write.
 * A future authorized run supplies each canonical TAM/TAL account separately. */
export function oraclePartnershipSearchPlan(company: { name: string; domain?: string | null }) {
  if (!company.name.trim()) throw new Error("Company name is required");
  const name = phrase(company.name);
  const terms = 'Oracle (partnership OR "partnered with" OR collaboration OR alliance OR "Oracle PartnerNetwork")';
  const queries = [`${name} ${terms}`];
  try {
    const url = new URL(company.domain?.includes("://") ? company.domain : `https://${company.domain ?? ""}`);
    const host = url.hostname.replace(/^www\./, "");
    if (/^https?:$/.test(url.protocol) && !url.username && !url.password && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) queries.push(`${phrase(host)} ${terms}`);
  } catch { /* Optional identity hint; never substitute a guessed domain. */ }
  return {
    signalType: "oracle_partnership" as const,
    execution: "manual_only" as const,
    news: queries.map(query => ({ query, url: googleNewsRss(query) })),
    linkedin: {
      query: `${name} Oracle partnership`,
      publicSearchQuery: `site:linkedin.com ${name} ${terms}`,
      url: `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(`${company.name.trim()} Oracle partnership`)}`,
    },
    evidenceRequired: "Read the complete original announcement or LinkedIn post, verify the exact account and Oracle counterparty, preserve event and publication dates, and use the existing reviewed publication route. Search snippets and empty searches are not findings.",
  };
}
