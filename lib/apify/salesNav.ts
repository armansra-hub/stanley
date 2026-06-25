import "server-only";
import { runActor } from "@/lib/apify/run";
import { isJuniorTitle } from "@/config/personas";
import type { Candidate } from "@/lib/ingest/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
const ACTOR = "bestscrapers/linkedin-sales-navigator-scraper";
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const snippet = (s?: unknown, n = 240) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * Phase 1 — initialize a Sales Nav search. Returns a request_id used later to
 * fetch results (the actor scrapes async, ~5–10 min). Returns null if the actor
 * rejects the search (invalid filters → not charged).
 */
export async function initSalesSearch(salesUrl: string, limit: number): Promise<string | null> {
  const items = await runActor(ACTOR, { sales_url: salesUrl, limit }, 1);
  const rid = items?.[0]?.request_id;
  return typeof rid === "string" && rid ? rid : null;
}

/**
 * Phase 2 — fetch one page of results for a request_id (≤100 leads/page). The
 * actor returns a single item shaped { data: [...leads], message }.
 */
export async function fetchSalesPage(requestId: string, page: number): Promise<Record<string, unknown>[]> {
  const items = await runActor(ACTOR, { request_id: requestId, page }, 100);
  const first = items?.[0] as { data?: unknown } | undefined;
  const leads = first?.data;
  return Array.isArray(leads) ? (leads as Record<string, unknown>[]) : [];
}

/**
 * Map people-search leads → candidates. The COMPANY is the entity; the new hire
 * (name + title) becomes the signal so the dashboard's "why it's here" reads
 * "<Person> recently became <Title> at <Company>". Each person's profile URL is
 * the unique source_url (so multiple new hires at one company each add a signal,
 * and re-runs dedupe). territory-trusted: the search is already industry-filtered
 * to the AE's TAM, so the orchestrator won't re-drop it as out-of-territory.
 */
export function mapPeopleLeads(items: Record<string, unknown>[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items) {
    const company = String(r.company ?? r.company_name ?? "").trim();
    const person = String(r.full_name ?? `${r.first_name ?? ""} ${r.last_name ?? ""}`).trim();
    const title = String(r.job_title ?? r.title ?? "").trim();
    const profile = str(r.linkedin_url) ?? str(r.profile_url);
    if (!company || !profile || !title) continue;
    // Backstop: the search is title-filtered to leadership, but skip anyone whose
    // current title is clearly junior (we only want decision-makers).
    if (isJuniorTitle(title)) continue;
    const loc = str(r.location);
    // Honest wording: LinkedIn's "<1yr tenure" filter is unreliable (it resets on
    // promotions/title changes) and the scraper gives no start date — so we state
    // only what's verifiable: a decision-maker is in seat, possibly newly.
    out.push({
      name: company,
      state: null,
      source: "discovered",
      sources: ["sales_nav"],
      trusted: true,
      signals: [{
        source_name: "LinkedIn Sales Navigator",
        source_url: profile,
        raw_excerpt:
          `${person || "A finance/operations leader"} is listed as ${title} at ${company}` +
          `${loc ? ` (${loc})` : ""}. Surfaced via a Sales Navigator search for finance/ops decision-makers with a recent (LinkedIn-estimated under-1-year) tenure — tenure unverified, may reflect a recent promotion. ` +
          `${snippet(r.about, 160)}`,
      }],
    });
  }
  return out;
}

/**
 * Map company-search leads → candidates (BS TAM Growth). Defensive field
 * handling until the growth search URL is wired and its output verified live.
 */
export function mapCompanyLeads(items: Record<string, unknown>[]): Candidate[] {
  const out: Candidate[] = [];
  for (const r of items) {
    const name = String(r.company ?? r.company_name ?? r.name ?? r.organization ?? "").trim();
    if (!name) continue;
    const website = str(r.website) ?? str(r.company_website) ?? str(r.domain);
    const url = str(r.linkedin_url) ?? str(r.company_url) ?? website ?? "https://www.linkedin.com";
    out.push({
      name,
      website,
      state: str(r.state) ?? null,
      source: "discovered",
      sources: ["sales_nav"],
      trusted: true,
      signals: [{
        source_name: "LinkedIn Sales Navigator",
        source_url: url,
        raw_excerpt: `${name} surfaced in the Business Services TAM growth Sales Navigator search (headcount-growth / hiring signal). ${snippet(r.description ?? r.about)}`,
      }],
    });
  }
  return out;
}
