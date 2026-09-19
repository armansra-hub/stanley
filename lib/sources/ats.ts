import "server-only";
import { createHash } from "node:crypto";
import { fetchPublicHttpText } from "@/lib/triggers/urlSafety";
import { companyPageUrl, discoverSiteLinks, htmlToVisibleText, sameCompanySite } from "./siteDiscovery";
import { publicResponseOutcome, sourceErrorCode, type SourceUrlOutcome } from "./outcomes";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ATS (applicant tracking system) job-board reader — FREE. Most companies post
 * jobs through Greenhouse / Lever / Ashby / SmartRecruiters / Recruitee / Workable,
 * each of which exposes a public JSON board. We:
 *   1) DETECT a company's board + slug from its careers page (one-time per company),
 *   2) POLL that board for open roles, and
 *   3) SCAN finance/accounting postings' descriptions for ERP-pain language — the
 *      most direct evidence a company is outgrowing QuickBooks/spreadsheets.
 * No keys, no Apify. Source-isolated: any failure returns empty / null.
 */

export type AtsType = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee" | "workable" | "wizehire";
export interface AtsJob { id?: string; title: string; description: string; url: string; location: string; date: string | null }

async function fetchText(url: string, ms = 7000, companyBase?: string): Promise<string | null> {
  try {
    const response = await fetchPublicHttpText(url, {
      timeoutMs: ms,
      maxBytes: 4_000_000,
      accept: "text/html,application/xhtml+xml,text/plain",
    });
    return response.status >= 200 && response.status < 300 && (!companyBase || sameCompanySite(response.finalUrl, companyBase)) ? response.body : null;
  } catch { return null; }
}
async function fetchJson(url: string, ms = 8000): Promise<any | null> {
  try {
    const response = await fetchPublicHttpText(url, {
      timeoutMs: ms,
      maxBytes: 4_000_000,
      accept: "application/json",
    });
    return response.status >= 200 && response.status < 300 ? JSON.parse(response.body) : null;
  } catch { return null; }
}

const htmlToText = (s: string) => htmlToVisibleText(String(s ?? ""));

// URL signatures that reveal the ATS + its slug (token), in priority order.
const ATS_PATTERNS: { type: AtsType; re: RegExp }[] = [
  { type: "greenhouse", re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9][a-z0-9_-]+)/i },
  { type: "greenhouse", re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "lever", re: /jobs\.lever\.co\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "smartrecruiters", re: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "recruitee", re: /([a-z0-9][a-z0-9_-]+)\.recruitee\.com/i },
  { type: "workable", re: /apply\.workable\.com\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "wizehire", re: /wizehire\.com\/jobroll\/v1\/bootstrap\/(\d+)\/jobroll\.js/i },
];
const BAD_TOKENS = new Set(["careers", "jobs", "company", "www", "embed", "job_board", "search", "about", "en-us", "en"]);

/** Follow actual company careers links before legacy paths; at most four pages. */
export type AtsDetection = { status: "detected" | "none" | "unsupported" | "unavailable"; board?: { type: AtsType; token: string }; outcomes: SourceUrlOutcome[]; unsupportedProvider?: string };
export async function detectAtsResult(domain: string): Promise<AtsDetection> {
  const base = `https://${domain.replace(/\/+$/, "")}`;
  const pending = [base];
  const seen = new Set<string>();
  const outcomes: SourceUrlOutcome[] = [];
  let unsupportedProvider: string | undefined;
  while (pending.length && seen.size < 4) {
    const page = pending.shift()!;
    if (seen.has(page)) continue;
    seen.add(page);
    let html: string | null = null;
    try {
      const response = await fetchPublicHttpText(page, { timeoutMs: 3500, maxBytes: 2000000 });
      const outcome = sameCompanySite(response.finalUrl, base) ? publicResponseOutcome(page, response.status, response.body)
        : { url: page, outcome: "unavailable" as const, code: "cross_company_redirect" as const };
      outcomes.push(outcome);
      if (outcome.outcome === "success") html = response.body;
    } catch (error) { outcomes.push({ url: page, outcome: "unavailable", code: sourceErrorCode(error) }); }
    if (!html) {
      if (page === base) for (const fallback of [`${base}/careers`, `${base}/jobs`]) {
        if (companyPageUrl(fallback, base)) pending.push(fallback);
      }
      continue;
    }
    for (const { type, re } of ATS_PATTERNS) {
      const m = html.match(re);
      const token = m?.[1]?.toLowerCase();
      if (token && !BAD_TOKENS.has(token) && token.length >= 2) return { status: "detected", board: { type, token }, outcomes };
    }
    // Report identifiable hosted systems outside our public API adapters rather
    // than implying that the company has no careers activity.
    const unsupported = html.match(/(?:[\w-]+\.)?(myworkdayjobs\.com|icims\.com|adp\.com|paylocity\.com|bamboohr\.com|applytojob\.com|jobvite\.com|ultipro\.com|taleo\.net)/i);
    if (unsupported) unsupportedProvider = unsupported[1].toLowerCase();
    for (const link of discoverSiteLinks(html, page).filter((link) => link.kind === "careers")) {
      if (!seen.has(link.url) && !pending.includes(link.url)) pending.push(link.url);
    }
    if (page === base) {
      for (const fallback of [`${base}/careers`, `${base}/jobs`]) {
        if (companyPageUrl(fallback, base) && !pending.includes(fallback)) pending.push(fallback);
      }
    }
  }
  return { status: unsupportedProvider ? "unsupported" : !outcomes.some(row => row.outcome === "success") || outcomes.some(row => row.outcome === "unavailable") ? "unavailable" : "none", outcomes, ...(unsupportedProvider ? { unsupportedProvider } : {}) };
}
export async function detectAts(domain: string): Promise<{ type: AtsType; token: string } | null> {
  return (await detectAtsResult(domain)).board ?? null;
}

export interface AtsJobBatch {
  jobs: AtsJob[];
  nextOffset: number | null;
  complete: boolean;
  status: "complete" | "partial" | "unavailable";
  snapshotKey?: string;
  expectedTotal?: number;
}

function jobDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function normalizeJob(type: AtsType, token: string, j: any): AtsJob {
  const id = j.id ?? j.shortcode ?? j.jobId ?? j.slug;
  const identity = id == null || String(id).length > 250 ? {} : { id: String(id) };
  if (type === "greenhouse") return { ...identity, title: String(j.title ?? ""), description: htmlToText(j.content ?? ""), url: String(j.absolute_url ?? ""), location: String(j.location?.name ?? ""), date: jobDate(j.updated_at) };
  if (type === "lever") return { ...identity, title: String(j.text ?? ""), description: htmlToText([j.descriptionPlain ?? j.description ?? "", ...(Array.isArray(j.lists) ? j.lists.map((list: any) => `${list.text ?? ""} ${list.content ?? ""}`) : []), j.additionalPlain ?? j.additional ?? ""].join(" ")), url: String(j.hostedUrl ?? ""), location: String(j.categories?.location ?? ""), date: jobDate(j.createdAt) };
  if (type === "ashby") return { ...identity, title: String(j.title ?? ""), description: htmlToText(j.descriptionPlain ?? j.descriptionHtml ?? ""), url: String(j.jobUrl ?? j.applyUrl ?? ""), location: String(j.location ?? j.locationName ?? ""), date: jobDate(j.publishedAt ?? j.updatedAt) };
  if (type === "smartrecruiters") return { ...identity, title: String(j.name ?? ""), description: htmlToText(Object.values(j.jobAd?.sections ?? {}).map((section: any) => section?.text ?? "").join(" ")), url: `https://jobs.smartrecruiters.com/${token}/${encodeURIComponent(String(j.id ?? ""))}`, location: String(j.location?.city ?? ""), date: jobDate(j.releasedDate ?? j.createdOn) };
  if (type === "recruitee") return { ...identity, title: String(j.title ?? ""), description: htmlToText(j.description ?? ""), url: String(j.careers_url ?? j.url ?? ""), location: String(j.location ?? ""), date: jobDate(j.published_at) };
  if (type === "workable") return { ...identity, title: String(j.title ?? ""), description: htmlToText(j.description ?? ""), url: String(j.url ?? j.shortlink ?? ""), location: String(j.location?.location_str ?? j.city ?? ""), date: jobDate(j.published_on ?? j.created_at) };
  return { ...identity, title: String(j.title ?? ""), description: htmlToText(j.snippet ?? ""), url: String(j.url ?? ""), location: String(j.location ?? ""), date: null };
}

/**
 * Bounded and resumable: Lever supports skip/limit; SmartRecruiters offset/limit.
 * Full-board APIs use a local offset over their response. Incomplete or failed
 * retrieval never reports an empty board as complete.
 * https://github.com/lever/postings-api
 * https://developers.smartrecruiters.com/docs/endpoints
 */
export async function fetchAtsJobsBatch(type: AtsType, token: string, options: { offset?: number; maxJobs?: number; maxPages?: number; budgetMs?: number } = {}): Promise<AtsJobBatch> {
  const start = Number.isSafeInteger(options.offset) && options.offset! >= 0 ? options.offset! : 0;
  const maxJobs = Number.isFinite(options.maxJobs) ? Math.max(1, Math.min(500, Math.floor(options.maxJobs!))) : 150;
  const maxPages = Number.isFinite(options.maxPages) ? Math.max(1, Math.min(5, Math.floor(options.maxPages!))) : 3;
  const deadline = Date.now() + Math.max(1000, Math.min(20_000, options.budgetMs ?? 12_000));
  const unavailable: AtsJobBatch = { jobs: [], nextOffset: start, complete: false, status: "unavailable" };
  if (!/^[a-z0-9][a-z0-9_-]{1,100}$/i.test(token)) return unavailable;
  const json = (url: string) => Date.now() >= deadline ? Promise.resolve(null) : fetchJson(url, Math.min(5000, deadline - Date.now()));
  const out: AtsJob[] = [];
  const seen = new Set<string>();
  let offset = start;
  let complete = false;
  let succeeded = false;
  let expectedTotal: number | undefined;
  let snapshotKey: string | undefined;
  let inconsistent = false;
  try {
    if (type === "lever" || type === "smartrecruiters") {
      for (let page = 0; page < maxPages && out.length < maxJobs && Date.now() < deadline; page++) {
        const limit = Math.min(50, maxJobs - out.length);
        const d = await json(type === "lever"
          ? `https://api.lever.co/v0/postings/${token}?mode=json&skip=${offset}&limit=${limit}`
          : `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=${limit}&offset=${offset}`);
        const rows = type === "lever" ? d : d?.content;
        if (!Array.isArray(rows)) break;
        succeeded = true;
        let added = 0;
        for (const row of rows.slice(0, limit)) {
          const job = normalizeJob(type, token, row);
          const key = job.url || `${job.title}|${job.location}`;
          if (seen.has(key)) { inconsistent = true; continue; }
          seen.add(key); out.push(job); added++;
        }
        // Providers ignoring pagination must not loop or falsely claim completion.
        if (rows.length > 0 && added === 0) break;
        offset += Math.min(rows.length, limit);
        const total = type === "smartrecruiters" && Number.isSafeInteger(d?.totalFound) && d.totalFound >= 0 ? d.totalFound : null;
        if (total != null) {
          if (expectedTotal !== undefined && total !== expectedTotal) inconsistent = true;
          expectedTotal = total;
        }
        if ((total == null && rows.length < limit) || (total != null && offset >= total)) { complete = true; break; }
        if (!rows.length) break; // an advertised remainder was not returned
      }
      if (type === "smartrecruiters" && Date.now() < deadline) {
        // List responses omit descriptions. Fetch only a small set of relevant
        // details; the remaining jobs still retain their real listing evidence.
        const detailJobs = out.filter((job) => !job.description && isOperatingJobTitle(job.title)).slice(0, 6);
        await Promise.all(detailJobs.map(async (job) => {
          const id = new URL(job.url).pathname.split("/").pop();
          const detail = await json(`https://api.smartrecruiters.com/v1/companies/${token}/postings/${id}`);
          if (detail && String(detail.id ?? "") === decodeURIComponent(id ?? "")) job.description = normalizeJob(type, token, detail).description;
        }));
      }
    } else {
      let rows: any = null;
      if (type === "greenhouse") rows = (await json(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`))?.jobs;
      else if (type === "ashby") rows = (await json(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=false`))?.jobs;
      else if (type === "recruitee") rows = (await json(`https://${token}.recruitee.com/api/offers/`))?.offers;
      else if (type === "workable") rows = (await json(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`))?.jobs;
      else if (type === "wizehire") {
        const body = await fetchText(`https://wizehire.com/jobroll/v1/jobs/${token}/jsonp`, Math.min(5000, deadline - Date.now()));
        const match = body?.match(/^\s*wh_cb\((.*)\);?\s*$/s);
        rows = match ? JSON.parse(match[1]) : null;
      }
      if (!Array.isArray(rows)) return unavailable;
      succeeded = true;
      expectedTotal = rows.length;
      snapshotKey = createHash("sha256").update(JSON.stringify(rows.map((row: any) => normalizeJob(type, token, row)).sort((a: AtsJob, b: AtsJob) => (a.id ?? a.url).localeCompare(b.id ?? b.url)))).digest("hex");
      const slice = rows.slice(start, start + maxJobs);
      for (const row of slice) out.push(normalizeJob(type, token, row));
      offset = start + slice.length;
      complete = offset >= rows.length;
    }
  } catch { /* isolated */ }
  if (inconsistent || out.some((job) => !job.title || !job.url)) complete = false;
  if (complete && expectedTotal === undefined) expectedTotal = offset;
  return { jobs: out.filter((job) => job.title), nextOffset: complete ? null : offset, complete, status: complete ? "complete" : succeeded ? "partial" : "unavailable", ...(snapshotKey ? { snapshotKey } : {}), ...(expectedTotal !== undefined ? { expectedTotal } : {}) };
}

/** Compatibility wrapper; callers needing complete coverage persist nextOffset. */
export async function fetchAtsJobs(type: AtsType, token: string, max = 150): Promise<AtsJob[]> {
  return (await fetchAtsJobsBatch(type, token, { maxJobs: max })).jobs;
}

// ── JD analysis ─────────────────────────────────────────────────────────────
const FINANCE_TITLE = /\b(controller|comptroller|cfo|chief financial officer|vp[\s,.-]{0,6}finance|director[\s,.-]{0,12}finance|finance director|accounting manager|finance manager|staff accountant|senior accountant|sr\.?\s+accountant|accounts payable|accounts receivable|\bap\b|\bar\b|bookkeeper|fp&a|financial analyst|payroll (manager|specialist|administrator)|billing (manager|specialist)|revenue (manager|accountant)|assistant controller)\b/i;
const OPERATING_TITLE = /\b(?:erp|business systems?|financial systems?|accounting systems?|systems? (?:analyst|administrator|implementation|integration)|integration (?:manager|lead|analyst)|project (?:accountant|accounting|controls?)|billing|revenue operations?|finance operations?|accounting operations?|implementation (?:manager|lead|consultant)|operations? (?:analyst|manager|director))\b/i;
const CLIENT_PLACEMENT = /\b(?:our client|on behalf of (?:a|our) client|client is (?:seeking|looking|hiring)|for (?:a|our) client|recruiting (?:for|on behalf of)|client engagements?|customers?['’]? erp|implement\w* (?:erp|systems?) for (?:our )?clients?)\b/i;
export function isOperatingJobTitle(title: string): boolean { return FINANCE_TITLE.test(title) || OPERATING_TITLE.test(title); }

// ERP-pain phrases in a job description = the company is outgrowing its systems.
const PAIN: { label: string; re: RegExp }[] = [
  { label: "QuickBooks", re: /\bquickbooks\b|\bqbo\b/i },
  { label: "Excel/manual processes", re: /\b(spreadsheet|excel)[- ]?(based|driven|heavy)\b|\bmanual (process|processes|reconciliation|reconciliations|journal entr|data entry)\b/i },
  { label: "implementing an ERP", re: /\bimplement(ing|ation|ed)?\s+(a\s+|an\s+|new\s+)?erp\b|\berp\s+(implementation|migration|rollout|selection|system)\b|\bnew\s+erp\b/i },
  { label: "revenue recognition / ASC 606", re: /\basc[\s-]?606\b|\brevenue recognition\b|\brev[\s-]?rec\b/i },
  { label: "month-end close", re: /\bmonth[\s-]?end close\b|\bclose process\b|\bclose the books\b/i },
  { label: "multi-entity / consolidation", re: /\bmulti[\s-]?entity\b|\binter[\s-]?company\b|\bconsolidat(e|ion|ing)\b/i },
  { label: "building out finance", re: /\b(scal|build|stand)(e|ing|ling)?\s+(out\s+)?(the\s+)?finance\b|\bfirst\s+(finance|accounting)\s+(hire|leader|team member)\b|\bnew\s+finance\s+function\b/i },
  { label: "systems implementation", re: /\bsystems?\s+implementation\b|\berp\s+admin\b/i },
  { label: "project accounting / job costing", re: /\bproject accounting\b|\bjob costing\b|\bproject (?:profitability|margins?)\b|\bwork[- ]in[- ]progress (?:billing|accounting)\b/i },
  { label: "billing operations", re: /\b(?:complex|recurring|subscription|milestone|usage[- ]based|project[- ]based) billing\b|\bquote[- ]to[- ]cash\b|\border[- ]to[- ]cash\b/i },
];
const ERP_INCUMBENT = /\b(netsuite|sage intacct|\bintacct\b|microsoft dynamics 365|dynamics 365|workday financials|oracle (erp|fusion|cloud financials)|sap (s\/?4hana|business one|erp))\b/i;
const QB_INCUMBENT = /\bquickbooks\b|\bqbo\b|\bxero\b|sage 50|sage 100|\bfreshbooks\b|wave accounting/i;

export interface JobScan { isFinance: boolean; isOperating: boolean; isClientPlacement: boolean; painHits: string[]; incumbent: "quickbooks" | "erp" | null }
export function scanJob(title: string, description: string): JobScan {
  const blob = `${title}\n${description}`;
  const isFinance = FINANCE_TITLE.test(title);
  const isOperating = isOperatingJobTitle(title);
  const isClientPlacement = CLIENT_PLACEMENT.test(blob);
  const painHits = PAIN.filter((p) => p.re.test(blob)).map((p) => p.label);
  // QuickBooks-class wins even if an ERP is also named (a migration JD is still in play);
  // a pure ERP mention means they're already on one → not a prospect.
  const incumbent = QB_INCUMBENT.test(blob) ? "quickbooks" : ERP_INCUMBENT.test(blob) ? "erp" : null;
  return { isFinance, isOperating, isClientPlacement, painHits, incumbent: isClientPlacement ? null : incumbent };
}
