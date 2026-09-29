import "server-only";
import { createHash } from "node:crypto";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { companyPageUrl, htmlAttributes, htmlToVisibleText, sameCompanySite, sitePageKind } from "@/lib/sources/siteDiscovery";
import { extractSiteText } from "@/lib/sources/siteContent";
import { publicResponseOutcome, sourceErrorCode, type SourceUrlOutcome } from "@/lib/sources/outcomes";
import { fetchPublicPdfEvidence } from "@/lib/sources/publicPdf";
import type { CustomerReferenceSource } from "./customerReferenceSources";

export type CustomerSourceCheckpoint = {
  version: 1;
  queue: { url: string; depth: number; from?: string }[];
  attempts: Record<string, { outcome: "success" | "missing" | "unavailable"; code?: string; status?: number; at: string; finalUrl?: string }>;
  pendingUrl?: string;
  completedAt?: string;
  sourceGaps: string[];
};
export type CustomerSourceInput = { id: string; name: string; domain: string | null; website: string | null; candidateUrls: string[]; sources: CustomerReferenceSource[] };
export type CustomerSourceCapture = { sources: CustomerReferenceSource[]; checkpoint: CustomerSourceCheckpoint; status: "running" | "pending" | "ready" | "blocked" };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
class SourceCaptureUnavailable extends Error {
  constructor(readonly outcome: SourceUrlOutcome, readonly finalUrl: string) { super(outcome.code ?? outcome.outcome); }
}
function customerCoreLinks(html: string, base: string): string[] {
  const links = new Set<string>();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const href = htmlAttributes(match[1]).href, url = href ? companyPageUrl(href, base, true) : null;
    if (!url) continue;
    const label = htmlToVisibleText(match[2]);
    // A footer's "Terms of Service" is a legal page, not an operating service.
    // Explicit evidence URLs and previously captured text are still retained.
    const path = new URL(url).pathname.toLowerCase().replace(/\/+$/, "");
    if (/\/(?:terms(?:[-_]of[-_](?:use|service))?|privacy(?:[-_]policy)?|cookie(?:s|[-_]policy)?|legal(?:[-_]notice)?)(?:\.[a-z]+)?$/.test(path)
      || /^(?:terms(?: of (?:use|service))?|privacy policy|cookie policy|legal notice)$/i.test(label.trim())) continue;
    const kind = sitePageKind(`${new URL(url).pathname} ${label}`);
    if (kind === "about" || kind === "services") links.add(url);
  }
  return [...links];
}

/** Actual public-page collection, never research-ledger prose. A pass follows
 * the website and supplied verified URLs plus their directly observed operating
 * links. It does not crawl an entire blog or invent paths. Every attempted URL
 * has a durable outcome, so a blocked site cannot become a retry loop. */
export async function collectCustomerReferenceSources(input: CustomerSourceInput, previous: CustomerSourceCheckpoint | null, deadline: number, deps: {
  fetchText?: typeof fetchPublicHttpText;
  fetchPdf?: typeof fetchPublicPdfEvidence;
  save: (capture: CustomerSourceCapture) => Promise<boolean>;
}): Promise<CustomerSourceCapture & { outcome: "ready" | "blocked" | "continued" | "lease_changed" }> {
  const sources = [...input.sources];
  const checkpoint: CustomerSourceCheckpoint = previous?.version === 1 ? structuredClone(previous)
    : { version: 1, queue: [], attempts: {}, sourceGaps: [] };
  const save = async (status: CustomerSourceCapture["status"]) => deps.save({ sources, checkpoint, status });
  const result = (status: CustomerSourceCapture["status"], outcome: "ready" | "blocked" | "continued" | "lease_changed") => ({ sources, checkpoint, status, outcome });
  const home = input.website && input.domain && sameCompanySite(input.website, `https://${input.domain}`) ? companyPageUrl(input.website, `https://${input.domain}`, true) : null;
  if (!home) {
    checkpoint.sourceGaps = [...new Set([...checkpoint.sourceGaps, "official_website_identity_unresolved"])];
    return await save("blocked") ? result("blocked", "blocked") : result("pending", "lease_changed");
  }
  const add = (raw: string, depth: number, from?: string) => {
    const url = companyPageUrl(raw, home, true);
    if (url && !checkpoint.queue.some(item => item.url === url)) checkpoint.queue.push({ url, depth, ...(from ? { from } : {}) });
  };
  add(home, 0);
  for (const candidate of input.candidateUrls) add(candidate, 0);
  // Successfully captured source URLs are retained, not fetched on every resume.
  for (const source of sources) {
    const url = companyPageUrl(source.url, home, true);
    if (url && !checkpoint.attempts[url]) checkpoint.attempts[url] = { outcome: "success", at: source.observedAt, finalUrl: source.url };
  }
  while (Date.now() < deadline - 8_000) {
    const next = checkpoint.queue.find(item => item.url === checkpoint.pendingUrl && !checkpoint.attempts[item.url])
      ?? checkpoint.queue.find(item => !checkpoint.attempts[item.url]);
    if (!next) {
      delete checkpoint.pendingUrl;
      checkpoint.completedAt = new Date().toISOString();
      const status = sources.length ? "ready" : "blocked";
      return await save(status) ? result(status, status) : result("pending", "lease_changed");
    }
    checkpoint.pendingUrl = next.url;
    if (!await save("running")) return result("pending", "lease_changed");
    const at = new Date().toISOString();
    try {
      let finalUrl: string, text: string, title: string, html = "";
      if (/\.pdf$/i.test(new URL(next.url).pathname)) {
        const pdf = await (deps.fetchPdf ?? fetchPublicPdfEvidence)(next.url, { mode: "deep", deadlineMs: Math.min(deadline - 2_000, Date.now() + 15_000), maxPages: 20, maxTextChars: 40_000 });
        if (pdf.status !== "extracted" || pdf.truncated) throw new Error("customer_pdf_incomplete");
        finalUrl = pdf.url; text = pdf.text; title = `${input.name} · official document`;
      } else {
        const response = await (deps.fetchText ?? fetchPublicHttpText)(next.url, { timeoutMs: Math.min(8_000, deadline - Date.now() - 2_000), maxBytes: 5_000_000, accept: "text/html,application/xhtml+xml,text/plain;q=0.8" });
        const outcome = publicResponseOutcome(next.url, response.status, response.body);
        if (outcome.outcome !== "success") throw new SourceCaptureUnavailable(outcome, response.finalUrl);
        if (response.status === 206) throw new Error("customer_source_partial_response");
        if (response.contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/i.test(response.contentType)) throw new Error("customer_source_unsupported_type");
        html = response.body; finalUrl = response.finalUrl;
        text = /text\/plain/i.test(response.contentType ?? "") ? response.body : extractSiteText(response.body);
        title = htmlToVisibleText(response.body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || input.name;
      }
      if (!sameCompanySite(finalUrl, home) || new URL(finalUrl).protocol !== "https:") throw new Error("customer_cross_company_redirect");
      if (!text.trim()) throw new Error("customer_source_empty");
      // No character slicing: the full extracted source is either kept or the
      // fetch/extraction fails with a visible gap.
      if (!sources.some(source => source.url === finalUrl)) sources.push({ id: `${input.id}-${digest(finalUrl).slice(0, 16)}`, url: finalUrl,
        title, text, contentHash: digest(text), observedAt: at, sourceKind: "website" });
      checkpoint.attempts[next.url] = { outcome: "success", status: 200, at, finalUrl };
      if (next.depth === 0 && html) for (const url of customerCoreLinks(html, finalUrl)) add(url, 1, finalUrl);
    } catch (error) {
      const reason = error instanceof SourceCaptureUnavailable ? error.outcome.code ?? error.outcome.outcome
        : error instanceof Error && error.message.startsWith("customer_") ? error.message
          : error instanceof Error && /size limit/i.test(error.message) ? "customer_source_exceeds_fetch_limit" : sourceErrorCode(error);
      checkpoint.attempts[next.url] = error instanceof SourceCaptureUnavailable ? { ...error.outcome, at, finalUrl: error.finalUrl }
        : { outcome: "unavailable", code: reason, at };
      checkpoint.sourceGaps.push(`${next.url}: ${reason}`);
    }
    delete checkpoint.pendingUrl;
    checkpoint.sourceGaps = [...new Set(checkpoint.sourceGaps)];
    if (!await save("running")) return result("pending", "lease_changed");
  }
  return await save("pending") ? result("pending", "continued") : result("pending", "lease_changed");
}
