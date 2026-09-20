import "server-only";
import Parser from "rss-parser";
import { googleNewsRss } from "@/config/news";
import { parseDateLoose } from "@/lib/time";
import type { Candidate } from "@/lib/ingest/types";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { publicResponseOutcome, sourceErrorCode, type SourceErrorCode } from "./outcomes";
import { fetchConditionalText, responseValidators, retainedValidators, type HttpValidators } from "./conditionalFetch";
import { normalizeFeedXml } from "./feedXml";

/**
 * Google News RSS adapter (FREE). Each item becomes a name-only candidate whose
 * "name" is the headline — the AI enrichment step extracts the actual company
 * and classifies territory. The article link is the signal's source_url.
 * Source-isolated: a failing feed never aborts the run.
 */
const parser = new Parser({ timeout: 12000, customFields: { item: [["source", "publisher", { keepArray: true }]] } });

async function parsePublicFeed(url: string) {
  const response = await fetchPublicHttpText(url, {
    timeoutMs: 12_000,
    maxBytes: 4_000_000,
    accept: "application/rss+xml,application/atom+xml,application/xml,text/xml",
  });
  if (response.status < 200 || response.status >= 300) throw new Error("feed request failed");
  return parser.parseString(normalizeFeedXml(response.body).xml);
}

export interface NewsItem { source_name: string; source_url: string; raw_excerpt: string; signal_date: string | null; publisher_url?: string; feed_excerpt?: string; discovery_query?: string }
export type NewsFeedCache = { validators?: HttpValidators; items: NewsItem[] };
export type NewsFetchOptions = { deadlineMs?: number; cache?: NewsFeedCache };
export type NewsFetchResult = { items: NewsItem[]; status: "success" | "empty" | "unavailable"; error?: SourceErrorCode; httpStatus?: number; cache?: NewsFeedCache; unchanged?: boolean };

export function readNewsFeedCache(value: unknown): NewsFeedCache | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  if (!Array.isArray(entry.items) || entry.items.length > 40) return undefined;
  const items = entry.items.filter((item): item is NewsItem => Boolean(item && typeof item === "object"
    && typeof item.source_url === "string" && item.source_url.length <= 2048 && typeof item.raw_excerpt === "string" && item.raw_excerpt.length <= 2000
    && typeof item.source_name === "string" && (item.signal_date === null || typeof item.signal_date === "string")));
  if (items.length !== entry.items.length) return undefined;
  const rawValidators = entry.validators as HttpValidators | undefined;
  return { items, validators: rawValidators?.url ? retainedValidators(rawValidators, rawValidators.url) : undefined };
}

/** A parsed empty feed is healthy. HTTP and parse errors are separately visible. */
export async function fetchNewsItemsResult(query: string, n = 6, options: NewsFetchOptions = {}): Promise<NewsFetchResult> {
  let response;
  try {
    const url = googleNewsRss(query);
    const timeoutMs = Math.min(10000, (options.deadlineMs ?? Date.now() + 10000) - Date.now());
    if (timeoutMs < 250) return { items: [], status: "unavailable", error: "timeout" };
    response = await fetchConditionalText(url, { timeoutMs, maxBytes: 4000000, accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" },
      { validators: options.cache?.validators, retained: Boolean(options.cache) });
    if (response.status === 304 && options.cache) {
      const items = options.cache.items.slice(0, n);
      return { items, status: items.length ? "success" : "empty", httpStatus: 304, unchanged: true, cache: options.cache };
    }
    const outcome = publicResponseOutcome(url, response.status, response.body);
    if (outcome.outcome !== "success") return { items: [], status: "unavailable", error: outcome.code ?? "http_error", httpStatus: response.status };
  } catch (error) { return { items: [], status: "unavailable", error: sourceErrorCode(error) }; }
  try {
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(response.body)) throw new Error("Not a feed");
    const feed = await parser.parseString(normalizeFeedXml(response.body).xml);
    const items = (feed.items ?? []).slice(0, n).map(item => {
      const source = (item as typeof item & { publisher?: { $?: { url?: string }; _?: string }[] }).publisher?.[0];
      const publisher = source && typeof source === "object" ? source.$?.url : undefined;
      return { source_name: "Google News", source_url: (item.link ?? "").trim(), raw_excerpt: (item.title ?? "").trim().slice(0, 2000), discovery_query: query,
        signal_date: parseDateLoose(item.isoDate ?? item.pubDate), ...(publisher ? { publisher_url: publisher } : {}),
        ...(item.contentSnippet ? { feed_excerpt: item.contentSnippet.slice(0, 2000) } : {}) };
    }).filter(item => item.source_url && item.raw_excerpt);
    return { items, status: items.length ? "success" : "empty", httpStatus: response.status, cache: { items, validators: responseValidators(response) } };
  } catch { return { items: [], status: "unavailable", error: "parse_error", httpStatus: response.status }; }
}

export type CompanyNewsContext = { name: string; domain?: string | null; publicAliases?: string[]; subindustry?: string | null; city?: string | null; state?: string | null };
const phrase = (value: string) => `"${value.replace(/["\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 140)}"`;
/** Broad name recall is permanent; additional queries are retrieval hints, not
 * proof that a same-named company or a site's editorial subject is this account. */
export function companyNewsQueries(company: CompanyNewsContext): string[] {
  const broad = phrase(company.name);
  const extra: string[] = [];
  let domain = "";
  try { domain = new URL(company.domain?.includes("://") ? company.domain : `https://${company.domain ?? ""}`).hostname.replace(/^www\./, ""); } catch { /* optional */ }
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) extra.push(`${broad} OR ${phrase(domain)}`);
  for (const alias of (company.publicAliases ?? []).slice(0, 3)) if (alias.trim().length >= 3 && alias.trim().toLowerCase() !== company.name.trim().toLowerCase()) extra.push(phrase(alias));
  const context = [company.subindustry, company.city, company.state].filter((value): value is string => Boolean(value?.trim())).slice(0, 2);
  if (context.length) extra.push(`${broad} (${context.map(phrase).join(" OR ")})`);
  return [broad, ...new Set(extra)].slice(0, 6);
}
export async function fetchNewsForCompanyResult(company: string | CompanyNewsContext, n = 24, options: { cycle?: number; caches?: Record<string, unknown>; deadlineMs?: number } = {}) {
  const queries = companyNewsQueries(typeof company === "string" ? { name: company } : company);
  const cycle = Number.isSafeInteger(options.cycle) && options.cycle! >= 0 ? options.cycle! : 0;
  const selected = [queries[0], ...(queries.length > 1 ? [queries[1 + cycle % (queries.length - 1)]] : [])];
  const deadlineMs = options.deadlineMs ?? Date.now() + 12000;
  const results = await Promise.all(selected.map((query, index) => fetchNewsItemsResult(query, index === 0 ? n : Math.min(n, 12), { deadlineMs, cache: readNewsFeedCache(options.caches?.[query]) })));
  const seen = new Set<string>(), items: NewsItem[] = [];
  // Interleave both searches; a noisy broad feed cannot hide the targeted source.
  for (let index = 0; index < n; index++) for (const result of results) {
    const item = result.items[index];
    if (item && !seen.has(item.source_url)) { seen.add(item.source_url); items.push(item); }
  }
  const failed = results.filter(result => result.status === "unavailable");
  const caches = Object.fromEntries(queries.flatMap(query => {
    const result = results[selected.indexOf(query)];
    const cache = result?.cache ?? readNewsFeedCache(options.caches?.[query]);
    return cache ? [[query, cache]] : [];
  }));
  return { items, status: failed.length === results.length ? "unavailable" as const : items.length ? "success" as const : "empty" as const,
    error: failed[0]?.error, httpStatus: results[0]?.httpStatus, partial: failed.length > 0, caches, nextCycle: cycle + 1,
    queries: selected.map((query, index) => ({ query, status: results[index].status, httpStatus: results[index].httpStatus, error: results[index].error, unchanged: results[index].unchanged ?? false })) };
}

/** Free Google News RSS fetch for an arbitrary query. Top N recent items. */
export async function fetchNewsItems(query: string, n = 6): Promise<NewsItem[]> {
  return (await fetchNewsItemsResult(query, n)).items;
}

/** Free signal check for one named company (used by CSV import). Top N recent items. */
export async function fetchNewsForCompany(name: string, n = 2): Promise<NewsItem[]> {
  return fetchNewsItems(`"${name}"`, n);
}

/** Parse an arbitrary RSS/Atom feed URL (a company's own newsroom/blog). */
export async function fetchFeed(url: string, n = 8): Promise<NewsItem[]> {
  return (await fetchFeedResult(url, n)).items;
}
export async function fetchFeedResult(url: string, n = 8, options: NewsFetchOptions = {}): Promise<NewsFetchResult> {
  try {
    const response = await fetchConditionalText(url, { timeoutMs: Math.min(12000, (options.deadlineMs ?? Date.now() + 12000) - Date.now()), maxBytes: 4_000_000,
      accept: "application/rss+xml,application/atom+xml,application/xml,text/xml" }, { validators: options.cache?.validators, retained: Boolean(options.cache) });
    if (response.status === 304 && options.cache) return { items: options.cache.items.slice(0, n), status: options.cache.items.length ? "success" : "empty", cache: options.cache, unchanged: true, httpStatus: 304 };
    const outcome = publicResponseOutcome(url, response.status, response.body);
    if (outcome.outcome !== "success") return { items: [], status: "unavailable", error: outcome.code, httpStatus: response.status };
    if (!/<(?:rss|feed|rdf:RDF)\b/i.test(response.body)) return { items: [], status: "unavailable", error: "parse_error" };
    const feed = await parser.parseString(normalizeFeedXml(response.body).xml);
    const items = (feed.items ?? []).slice(0, n).map((item) => ({
      source_name: "Company newsroom",
      source_url: (item.link ?? url).trim(),
      raw_excerpt: (item.title ?? "").trim(),
      signal_date: parseDateLoose(item.isoDate ?? item.pubDate),
    })).filter((s) => s.raw_excerpt);
    return { items, status: items.length ? "success" : "empty", cache: { items, validators: responseValidators(response) }, httpStatus: response.status };
  } catch (error) { return { items: [], status: "unavailable", error: sourceErrorCode(error) }; }
}

export async function fetchGoogleNewsCandidates(
  queries: string[],
  perQuery = 3,
  maxTotal = Infinity,
): Promise<Candidate[]> {
  // Fetch all queries in parallel (source-isolated), then dedupe by article
  // link across queries and cap the total to bound enrichment cost.
  const feeds = await Promise.allSettled(queries.map((q) => parsePublicFeed(googleNewsRss(q))));
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const f of feeds) {
    if (f.status !== "fulfilled") continue;
    let kept = 0;
    for (const item of f.value.items ?? []) {
      if (kept >= perQuery) break;
      const title = (item.title ?? "").trim();
      const link = (item.link ?? "").trim();
      if (!title || !link || seen.has(link)) continue;
      seen.add(link);
      const signal_date = parseDateLoose(item.isoDate ?? item.pubDate);
      out.push({
        name: title,
        source: "discovered",
        sources: ["google_news"],
        signals: [{ source_name: "Google News", source_url: link, raw_excerpt: title, signal_date }],
      });
      kept++;
      if (out.length >= maxTotal) return out;
    }
  }
  return out;
}
