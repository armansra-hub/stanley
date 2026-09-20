import { createHash } from "node:crypto";
import { fetchPublicHttpText, validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { htmlAttributes, htmlToVisibleText } from "./siteDiscovery";
import { publicResponseOutcome } from "./outcomes";
import type { AtsJob, AtsJobBatch } from "./ats";

type HostedType = "jazzhr" | "jobvite";
function boardUrl(type: HostedType, token: string) {
  return type === "jazzhr" ? `https://${token}.applytojob.com/apply/jobs/` : `https://jobs.jobvite.com/${token}/`;
}
function listingUrl(raw: string, base: string, type: HostedType, token: string): string | null {
  try {
    const url = validatePublicHttpUrl(new URL(raw, base));
    if (url.hostname !== new URL(base).hostname) return null;
    const pattern = type === "jazzhr" ? /^\/apply\/(?:jobs\/details\/)?([a-z0-9]{6,})(?:\/[^/?]+)?\/?$/i : new RegExp(`^/${token}/job/[a-z0-9_-]+/?$`, "i");
    if (!pattern.test(url.pathname)) return null;
    url.hash = ""; url.search = "";
    return url.toString();
  } catch { return null; }
}
export function parseHostedListings(html: string, type: HostedType, token: string): AtsJob[] {
  const base = boardUrl(type, token), jobs = new Map<string, AtsJob>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = htmlAttributes(match[1]);
    const url = attrs.href ? listingUrl(attrs.href, base, type, token) : null;
    const title = htmlToVisibleText(match[2]).trim().slice(0, 300);
    if (!url || !title || /^(?:apply(?: now)?|learn more|view(?: job| details)?)$/i.test(title)) continue;
    jobs.set(url, { id: new URL(url).pathname.match(type === "jazzhr" ? /\/apply\/(?:jobs\/details\/)?([^/]+)/ : /\/job\/([^/]+)/)?.[1], title, url, description: "", location: "", date: null });
  }
  return [...jobs.values()].sort((a, b) => a.url.localeCompare(b.url));
}
export function hostedJobDetail(html: string, expected: AtsJob): AtsJob | null {
  const postings: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0) => {
    if (depth > 5 || postings.length > 10 || !value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const row of value.slice(0, 100)) visit(row, depth + 1); return; }
    const row = value as Record<string, unknown>;
    if (row["@type"] === "JobPosting" || Array.isArray(row["@type"]) && row["@type"].includes("JobPosting")) postings.push(row);
    if (row["@graph"]) visit(row["@graph"], depth + 1);
  };
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (htmlAttributes(match[1]).type?.toLowerCase() !== "application/ld+json" || match[2].length > 500_000) continue;
    try { visit(JSON.parse(match[2])); } catch { /* Invalid schema is not a job description. */ }
  }
  const titleKey = (title: string) => htmlToVisibleText(title).toLowerCase().replace(/\s+/g, " ").trim();
  const matched = postings.filter(row => typeof row.title === "string" && titleKey(row.title) === titleKey(expected.title));
  if (matched.length !== 1 || typeof matched[0].description !== "string") return null;
  const row = matched[0];
  if (typeof row.url === "string") {
    try { if (new URL(row.url).hostname !== new URL(expected.url).hostname) return null; } catch { return null; }
  }
  const places = Array.isArray(row.jobLocation) ? row.jobLocation : [row.jobLocation];
  const location = places.slice(0, 8).flatMap(place => {
    if (!place || typeof place !== "object") return [];
    const address = (place as { address?: Record<string, unknown> }).address;
    if (!address || typeof address !== "object") return [];
    return [[address.addressLocality, address.addressRegion, address.addressCountry].filter(value => typeof value === "string").join(", ")];
  }).filter(Boolean).join("; ");
  const date = typeof row.datePosted === "string" && Number.isFinite(Date.parse(row.datePosted)) ? new Date(row.datePosted).toISOString() : null;
  return { ...expected, description: htmlToVisibleText(String(row.description)).slice(0, 40000), location: location.slice(0, 1000), date };
}

/** First-party public hosted boards. Jobvite documents hosted-site scraping:
 * https://careers.jobvite.com/careersite/source_tracking.html
 * JazzHR exposes employer listings and per-job JobPosting JSON-LD at
 * https://<tenant>.applytojob.com/apply/jobs/ (observed 2026-09-19).
 * These are bounded listing collectors, not access to private recruiting APIs. */
export async function fetchHostedAtsBatch(type: HostedType, token: string, options: { offset: number; maxJobs: number; deadline: number }): Promise<AtsJobBatch> {
  const unavailable: AtsJobBatch = { jobs: [], nextOffset: options.offset, complete: false, status: "unavailable", coverageKind: "public_hosted_board" };
  if (!/^[a-z0-9][a-z0-9_-]{1,100}$/i.test(token) || options.deadline - Date.now() < 250) return unavailable;
  const base = boardUrl(type, token);
  try {
    const response = await fetchPublicHttpText(base, { timeoutMs: Math.min(5000, options.deadline - Date.now()), maxBytes: 3_000_000 });
    if (new URL(response.finalUrl).hostname !== new URL(base).hostname || publicResponseOutcome(base, response.status, response.body).outcome !== "success") return unavailable;
    const listings = parseHostedListings(response.body, type, token);
    const genuineEmpty = /(?:no (?:current(?:ly)? |open |available )?(?:job openings|open positions|positions available|jobs available)|there are currently no)/i.test(htmlToVisibleText(response.body))
      && (type === "jazzhr" ? /JazzHR|applytojob/i.test(response.body) : /Jobvite|jv-job-list/i.test(response.body));
    if (!listings.length && !genuineEmpty) return unavailable;
    // Unknown server pagination cannot prove board completion or expire jobs.
    const morePages = /<(?:a|link)\b[^>]*\brel=["'][^"']*\bnext\b/i.test(response.body)
      || /href=["'][^"']*[?&](?:page|offset|start)=\d+/i.test(response.body);
    const jobs = listings.slice(options.offset, options.offset + Math.min(options.maxJobs, 30));
    let descriptionsFetched = 0, descriptionsUnavailable = 0;
    // Six descriptions per bounded turn. All listing rows still advance the
    // durable lifecycle; unknown descriptions/dates never become invented facts.
    const detailCandidates = jobs.filter(job => /finance|account|controller|cfo|billing|systems|operations|payroll|revenue|project/i.test(job.title)).slice(0, 6);
    for (let index = 0; index < detailCandidates.length && options.deadline - Date.now() >= 300; index += 3) {
      await Promise.all(detailCandidates.slice(index, index + 3).map(async job => {
        try {
          const detail = await fetchPublicHttpText(job.url, { timeoutMs: Math.min(3500, options.deadline - Date.now()), maxBytes: 1_000_000 });
          if (detail.status !== 200 || new URL(detail.finalUrl).hostname !== new URL(base).hostname) { descriptionsUnavailable++; return; }
          const parsed = hostedJobDetail(detail.body, job);
          if (parsed) { Object.assign(job, parsed); descriptionsFetched++; } else descriptionsUnavailable++;
        } catch { descriptionsUnavailable++; }
      }));
    }
    const nextOffset = options.offset + jobs.length;
    const complete = !morePages && nextOffset >= listings.length;
    return { jobs, nextOffset: complete ? null : morePages && nextOffset >= listings.length ? 0 : nextOffset, complete,
      status: complete ? "complete" : "partial", expectedTotal: morePages ? undefined : listings.length,
      snapshotKey: createHash("sha256").update(JSON.stringify(listings.map(job => [job.id, job.title, job.url]))).digest("hex"),
      coverageKind: morePages ? "hosted_board_pagination_unresolved" : "public_hosted_board", descriptionsFetched, descriptionsUnavailable };
  } catch { return unavailable; }
}
