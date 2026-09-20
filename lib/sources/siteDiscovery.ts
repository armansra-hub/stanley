import { createHash } from "node:crypto";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { decodeEntities, htmlAttributes, extractSiteText, extractCompanyIdentity, type SiteCompanyIdentity } from "./siteContent";
export { decodeEntities, htmlAttributes } from "./siteContent";

export type SitePageKind = "news" | "careers" | "about" | "locations" | "services";
export interface DiscoveredSiteLink { url: string; kind: SitePageKind; label: string }
export interface SiteDateReference {
  value: string;
  kind: "published" | "modified" | "time";
  source: string;
}
export interface SitePageEvidence {
  url: string;
  title: string;
  text: string;
  contentHash: string;
  sourceDates: SiteDateReference[];
  truncated: boolean;
  companyIdentity?: SiteCompanyIdentity;
  requestedUrls?: string[];
}

/** Keep company identity attached to the supplied domain, including its subdomains. */
export function sameCompanySite(candidate: string, base: string): boolean {
  try {
    const url = validatePublicHttpUrl(candidate);
    const home = validatePublicHttpUrl(base);
    const host = home.hostname.replace(/^www\./i, "").toLowerCase();
    const other = url.hostname.replace(/^www\./i, "").toLowerCase();
    return other === host || other.endsWith(`.${host}`);
  } catch { return false; }
}

export function companyPageUrl(raw: string, base: string, allowPdf = false): string | null {
  try {
    const url = new URL(decodeEntities(raw), base);
    if (!sameCompanySite(url.toString(), base)) return null;
    if ((!allowPdf && /\.pdf(?:$|\/)/i.test(url.pathname)) || /\.(?:png|jpe?g|gif|webp|svg|zip|gz|css|js|mp4|woff2?)(?:$|\/)/i.test(url.pathname)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return null; }
}

export function sitePageKind(value: string): SitePageKind | null {
  const text = value.replace(/[-_/]+/g, " ");
  if (/\b(careers?|jobs?|employment|open positions?|join (?:our )?team|work (?:with|for) us)\b/i.test(text)) return "careers";
  if (/\b(news(?:room)?|press|announcements?|acquisitions?|insights?|blog|media center)\b/i.test(text)) return "news";
  if (/\b(locations?|offices?|branches|where we (?:are|work))\b/i.test(text)) return "locations";
  if (/\b(about|our company|who we are|leadership|our team)\b/i.test(text)) return "about";
  if (/\b(services?|solutions?|what we do|industries|capabilities|expertise|practice areas?|case stud(?:y|ies)|our work|projects?|pricing|plans|terms|billing)\b/i.test(text)) return "services";
  return null;
}

export function discoverSiteLinks(html: string, base: string, options: { includePdf?: boolean } = {}): DiscoveredSiteLink[] {
  const links: DiscoveredSiteLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = htmlAttributes(match[1]).href;
    if (!href) continue;
    const url = companyPageUrl(href, base, options.includePdf === true);
    const label = htmlToVisibleText(match[2]);
    const kind = sitePageKind(`${url ? new URL(url).pathname : ""} ${label}`)
      ?? (options.includePdf && url && /\.pdf$/i.test(new URL(url).pathname)
        && /\b(capabilit|annual|report|brochure|overview|contract)/i.test(`${url} ${label}`) ? "services" : null);
    if (!url || !kind || seen.has(url)) continue;
    seen.add(url);
    links.push({ url, kind, label: label.slice(0, 160) });
    if (links.length >= 200) break;
  }
  return links;
}

/** Bounded XML discovery only; external URLs never become company evidence. */
export function sitemapLocations(xml: string, base: string): string[] {
  const urls: string[] = [];
  for (const match of xml.matchAll(/<loc\b[^>]*>\s*(?:<!\[CDATA\[)?([^<]+?)(?:\]\]>)?\s*<\/loc>/gi)) {
    const url = companyPageUrl(match[1].trim(), base);
    if (url && !urls.includes(url)) urls.push(url);
    if (urls.length >= 300) break;
  }
  return urls;
}

export function htmlToVisibleText(html: string): string {
  return decodeEntities(html
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ").trim();
}

/** Stable content excludes navigation/footer chrome; dates retain their source kind. */
export function sitePageEvidence(html: string, url: string): SitePageEvidence {
  const text = extractSiteText(html);
  const companyIdentity = extractCompanyIdentity(html, url, candidate => sameCompanySite(candidate, url));
  const sourceDates: SiteDateReference[] = [];
  const add = (value: string | undefined, kind: SiteDateReference["kind"], source: string) => {
    // Accept explicit source dates, including labeled prose. Never interpret an
    // arbitrary number, copyright year, or collection timestamp as publication.
    const raw = value?.trim();
    if (!raw || !/^(?:\d{4}-\d{2}-\d{2}(?:T|$)|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}$)/i.test(raw) || !Number.isFinite(Date.parse(raw))) return;
    const normalized = new Date(/^\d{4}-/.test(raw) ? raw : `${raw} UTC`).toISOString();
    if (!sourceDates.some((date) => date.value === normalized && date.kind === kind)) sourceDates.push({ value: normalized, kind, source });
  };
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const name = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (/^(article:published_time|datepublished|date|pubdate)$/.test(name)) add(attrs.content, "published", name);
    if (/^(article:modified_time|datemodified|last-modified)$/.test(name)) add(attrs.content, "modified", name);
  }
  for (const match of html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time\s*>/gi)) {
    const attrs = htmlAttributes(match[1]);
    const kind = attrs.itemprop?.toLowerCase() === "datepublished" ? "published" : attrs.itemprop?.toLowerCase() === "datemodified" ? "modified" : "time";
    add(attrs.datetime ?? htmlToVisibleText(match[2]), kind, `time[${attrs.itemprop ?? "datetime"}]`);
  }
  for (const match of html.matchAll(/"(datePublished|dateModified)"\s*:\s*"([^"]+)"/g)) {
    add(match[2], match[1] === "datePublished" ? "published" : "modified", `json-ld.${match[1]}`);
  }
  for (const match of text.slice(0, 3000).matchAll(/\b(Published|Posted|Last updated|Updated)(?:\s+on)?\s*:?\s*((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2})\b/gi)) {
    add(match[2], /updated/i.test(match[1]) ? "modified" : "published", "labeled_visible_date");
  }
  return {
    url, title: htmlToVisibleText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 300),
    text: text.slice(0, 24_000), contentHash: createHash("sha256").update(text).digest("hex"),
    sourceDates: sourceDates.slice(0, 12), truncated: text.length > 24_000,
    ...(companyIdentity ? { companyIdentity } : {}),
  };
}
