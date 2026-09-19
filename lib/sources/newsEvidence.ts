import "server-only";
import { fetchPublicHttpText, validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { htmlAttributes, sitePageEvidence } from "./siteDiscovery";
import { publicResponseOutcome, sourceErrorCode, type SourceErrorCode } from "./outcomes";
import type { NewsItem } from "./googleNews";
import { googleArticleId, legacyGoogleArticleUrl, resolveGoogleArticle } from "./googleNewsDecoder";

const googleGateway = (url: URL) => /(?:^|\.)(?:google\.com|googleusercontent\.com|gstatic\.com)$/i.test(url.hostname);
export function publisherArticleLinks(html: string, publisherUrl?: string): string[] {
  let publisher: URL;
  try { publisher = validatePublicHttpUrl(publisherUrl ?? ""); } catch { return []; }
  const host = publisher.hostname.replace(/^www\./, "");
  const links: string[] = [];
  for (const match of html.matchAll(/<(?:a|link)\b[^>]*>/gi)) {
    const attributes = htmlAttributes(match[0]);
    if (!attributes.href) continue;
    try {
      const url = validatePublicHttpUrl(attributes.href);
      const actualHost = url.hostname.replace(/^www\./, "");
      if ((actualHost === host || actualHost.endsWith(`.${host}`)) && url.pathname.replace(/\/+$/, "").length > 1 && !googleGateway(url)) links.push(url.toString());
    } catch { /* Navigation and non-public links cannot become publisher evidence. */ }
  }
  const unique = [...new Set(links)];
  // Several publisher links are ambiguous navigation, not an article redirect.
  return unique.length === 1 ? unique : [];
}

/** Fetch a real publisher body when ordinary public redirects/links provide it.
 * Google public link resolution enriches ordinary redirects. No invented
 * publisher URL, consent bypass, or unrelated third-party crawler. */
export async function readNewsEvidence(item: Pick<NewsItem, "source_url" | "raw_excerpt" | "publisher_url" | "feed_excerpt">) {
  let failure: SourceErrorCode = "publisher_unresolved";
  let httpStatus: number | undefined;
  const id = googleArticleId(item.source_url);
  const legacy = id ? legacyGoogleArticleUrl(id) : null;
  const candidates = [legacy ?? item.source_url];
  let resolutionMethod = legacy ? "base64_protobuf" : "direct_or_redirect";
  for (let index = 0; index < candidates.length && index < 3; index++) {
    try {
      const response = await fetchPublicHttpText(candidates[index], { timeoutMs: index ? 4000 : 5000, maxRedirects: 6, maxBytes: 1000000 });
      httpStatus = response.status;
      const outcome = publicResponseOutcome(candidates[index], response.status, response.body);
      if (outcome.outcome !== "success") { failure = outcome.code ?? "http_error"; continue; }
      const final = validatePublicHttpUrl(response.finalUrl);
      if (googleGateway(final)) {
        const links = publisherArticleLinks(response.body, item.publisher_url);
        if (links.length) { candidates.push(...links.filter(url => !candidates.includes(url))); resolutionMethod = "publisher_link"; }
        else {
          const resolved = await resolveGoogleArticle(item.source_url, response.body);
          if (resolved && !candidates.includes(resolved.url)) { candidates.push(resolved.url); resolutionMethod = resolved.method; }
        }
        continue;
      }
      const page = sitePageEvidence(response.body, final.toString());
      if (final.pathname.replace(/\/+$/, "").length < 2 || page.text.length < 160) { failure = "empty_body"; continue; }
      return { sourceUrl: page.url, text: page.text, metadata: { evidenceKind: "article_body", articleBodyAvailable: true,
        feedUrl: item.source_url, publisherUrl: item.publisher_url ?? null, sourceDates: page.sourceDates, textTruncated: page.truncated,
        ...(page.companyIdentity ? { publisherIdentity: page.companyIdentity } : {}),
        eventDateBasis: "feed_publication", publisherResolution: resolutionMethod }, bodyAvailable: true, error: null };
    } catch (error) { failure = sourceErrorCode(error); }
  }
  // Exact feed headline only; no HTML gateway, cookie/consent text or invented
  // article body is supplied to Jev. A later body capture can enrich this finding.
  return { sourceUrl: item.source_url, text: item.raw_excerpt, metadata: { evidenceKind: "headline_only", articleBodyAvailable: false,
    feedUrl: item.source_url, publisherUrl: item.publisher_url ?? null, eventDateBasis: "feed_publication",
    articleFetchError: failure, httpStatus: httpStatus ?? null, publisherResolution: resolutionMethod }, bodyAvailable: false, error: failure };
}
