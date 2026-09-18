import { createHash } from "node:crypto";
import { validatePublicHttpUrl } from "@/lib/triggers/urlSafety";

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
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (entity[0] !== "#") return named[entity.toLowerCase()] ?? match;
    const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

export function htmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attributes[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
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

export function companyPageUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(decodeEntities(raw), base);
    if (!sameCompanySite(url.toString(), base)) return null;
    if (/\.(?:pdf|png|jpe?g|gif|webp|svg|zip|gz|css|js|mp4|woff2?)(?:$|\/)/i.test(url.pathname)) return null;
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
  if (/\b(services?|solutions?|what we do|industries)\b/i.test(text)) return "services";
  return null;
}

export function discoverSiteLinks(html: string, base: string): DiscoveredSiteLink[] {
  const links: DiscoveredSiteLink[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = htmlAttributes(match[1]).href;
    if (!href) continue;
    const url = companyPageUrl(href, base);
    const label = htmlToVisibleText(match[2]);
    const kind = sitePageKind(`${url ? new URL(url).pathname : ""} ${label}`);
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
  const meaningful = html
    .replace(/<(script|style|noscript|svg|template|nav|header|footer|aside|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const body = meaningful.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)\s*>/i)?.[1] ?? meaningful;
  const text = htmlToVisibleText(body);
  const sourceDates: SiteDateReference[] = [];
  const add = (value: string | undefined, kind: SiteDateReference["kind"], source: string) => {
    // Only explicit ISO-like source dates. Never substitute collection time.
    if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value) || !Number.isFinite(Date.parse(value))) return;
    if (!sourceDates.some((date) => date.value === value && date.kind === kind)) sourceDates.push({ value, kind, source });
  };
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    const name = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (/^(article:published_time|datepublished|date|pubdate)$/.test(name)) add(attrs.content, "published", name);
    if (/^(article:modified_time|datemodified|last-modified)$/.test(name)) add(attrs.content, "modified", name);
  }
  for (const match of html.matchAll(/<time\b[^>]*>/gi)) add(htmlAttributes(match[0]).datetime, "time", "time[datetime]");
  for (const match of html.matchAll(/"(datePublished|dateModified)"\s*:\s*"([^"]+)"/g)) {
    add(match[2], match[1] === "datePublished" ? "published" : "modified", `json-ld.${match[1]}`);
  }
  return {
    url, title: htmlToVisibleText(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").slice(0, 300),
    text: text.slice(0, 24_000), contentHash: createHash("sha256").update(text).digest("hex"),
    sourceDates: sourceDates.slice(0, 12), truncated: text.length > 24_000,
  };
}
