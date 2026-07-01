import "server-only";

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

export type AtsType = "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "recruitee" | "workable";
export interface AtsJob { title: string; description: string; url: string; location: string; date: string | null }

const UA = "Mozilla/5.0 (compatible; StanleyTAMBot/1.0; +https://jarvis-sable-eta.vercel.app)";

async function fetchText(url: string, ms = 7000): Promise<string | null> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA } });
    clearTimeout(to);
    return r.ok ? await r.text() : null;
  } catch { return null; }
}
async function fetchJson(url: string, ms = 8000): Promise<any | null> {
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": UA, accept: "application/json" } });
    clearTimeout(to);
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const htmlToText = (s: string) => String(s ?? "").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

// URL signatures that reveal the ATS + its slug (token), in priority order.
const ATS_PATTERNS: { type: AtsType; re: RegExp }[] = [
  { type: "greenhouse", re: /greenhouse\.io\/embed\/job_board\?for=([a-z0-9][a-z0-9_-]+)/i },
  { type: "greenhouse", re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "lever", re: /jobs\.lever\.co\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "ashby", re: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "smartrecruiters", re: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9][a-z0-9_-]+)/i },
  { type: "recruitee", re: /([a-z0-9][a-z0-9_-]+)\.recruitee\.com/i },
  { type: "workable", re: /apply\.workable\.com\/([a-z0-9][a-z0-9_-]+)/i },
];
const BAD_TOKENS = new Set(["careers", "jobs", "company", "www", "embed", "job_board", "search", "about", "en-us", "en"]);

/** Find a company's ATS + slug from its site. Caps at ~3 fetches (home, /careers, /jobs). */
export async function detectAts(domain: string): Promise<{ type: AtsType; token: string } | null> {
  const base = `https://${domain.replace(/\/+$/, "")}`;
  for (const page of [base, `${base}/careers`, `${base}/jobs`]) {
    const html = await fetchText(page);
    if (!html) continue;
    for (const { type, re } of ATS_PATTERNS) {
      const m = html.match(re);
      const token = m?.[1]?.toLowerCase();
      if (token && !BAD_TOKENS.has(token) && token.length >= 2) return { type, token };
    }
  }
  return null;
}

/** Poll a known board for open roles (normalized). Caps results. */
export async function fetchAtsJobs(type: AtsType, token: string, max = 60): Promise<AtsJob[]> {
  const out: AtsJob[] = [];
  try {
    if (type === "greenhouse") {
      const d = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`);
      for (const j of (d?.jobs ?? []).slice(0, max)) out.push({ title: String(j.title ?? ""), description: htmlToText(j.content ?? ""), url: String(j.absolute_url ?? ""), location: String(j.location?.name ?? ""), date: j.updated_at ?? null });
    } else if (type === "lever") {
      const d = await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`);
      for (const j of (Array.isArray(d) ? d : []).slice(0, max)) out.push({ title: String(j.text ?? ""), description: htmlToText(j.descriptionPlain ?? j.description ?? ""), url: String(j.hostedUrl ?? ""), location: String(j.categories?.location ?? ""), date: j.createdAt ? new Date(Number(j.createdAt)).toISOString() : null });
    } else if (type === "ashby") {
      const d = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}?includeCompensation=false`);
      for (const j of (d?.jobs ?? []).slice(0, max)) out.push({ title: String(j.title ?? ""), description: htmlToText(j.descriptionPlain ?? j.descriptionHtml ?? ""), url: String(j.jobUrl ?? j.applyUrl ?? ""), location: String(j.location ?? j.locationName ?? ""), date: j.publishedAt ?? j.updatedAt ?? null });
    } else if (type === "smartrecruiters") {
      const d = await fetchJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`);
      for (const j of (d?.content ?? []).slice(0, max)) out.push({ title: String(j.name ?? ""), description: "", url: `https://jobs.smartrecruiters.com/${token}/${j.id ?? ""}`, location: String(j.location?.city ?? ""), date: j.releasedDate ?? j.createdOn ?? null });
    } else if (type === "recruitee") {
      const d = await fetchJson(`https://${token}.recruitee.com/api/offers/`);
      for (const j of (d?.offers ?? []).slice(0, max)) out.push({ title: String(j.title ?? ""), description: htmlToText(j.description ?? ""), url: String(j.careers_url ?? j.url ?? ""), location: String(j.location ?? ""), date: j.published_at ?? null });
    } else if (type === "workable") {
      const d = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`);
      for (const j of (d?.jobs ?? []).slice(0, max)) out.push({ title: String(j.title ?? ""), description: htmlToText(j.description ?? ""), url: String(j.url ?? j.shortlink ?? ""), location: String(j.location?.location_str ?? j.city ?? ""), date: j.published_on ?? j.created_at ?? null });
    }
  } catch { /* isolated */ }
  return out.filter((j) => j.title);
}

// ── JD analysis ─────────────────────────────────────────────────────────────
const FINANCE_TITLE = /\b(controller|comptroller|cfo|chief financial officer|vp[\s,.-]{0,6}finance|director[\s,.-]{0,12}finance|finance director|accounting manager|finance manager|staff accountant|senior accountant|sr\.?\s+accountant|accounts payable|accounts receivable|\bap\b|\bar\b|bookkeeper|fp&a|financial analyst|payroll (manager|specialist|administrator)|billing (manager|specialist)|revenue (manager|accountant)|assistant controller)\b/i;

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
];
const ERP_INCUMBENT = /\b(netsuite|sage intacct|\bintacct\b|microsoft dynamics 365|dynamics 365|workday financials|oracle (erp|fusion|cloud financials)|sap (s\/?4hana|business one|erp))\b/i;
const QB_INCUMBENT = /\bquickbooks\b|\bqbo\b|\bxero\b|sage 50|sage 100|\bfreshbooks\b|wave accounting/i;

export interface JobScan { isFinance: boolean; painHits: string[]; incumbent: "quickbooks" | "erp" | null }
export function scanJob(title: string, description: string): JobScan {
  const blob = `${title}\n${description}`;
  const isFinance = FINANCE_TITLE.test(title);
  const painHits = PAIN.filter((p) => p.re.test(blob)).map((p) => p.label);
  // QuickBooks-class wins even if an ERP is also named (a migration JD is still in play);
  // a pure ERP mention means they're already on one → not a prospect.
  const incumbent = QB_INCUMBENT.test(blob) ? "quickbooks" : ERP_INCUMBENT.test(blob) ? "erp" : null;
  return { isFinance, painHits, incumbent };
}
