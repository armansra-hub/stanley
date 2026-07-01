import "server-only";
import { pickSitesForRotation, setSiteChecked, setParent, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { setCompaniesStatus } from "@/lib/db/companies";
import { getAppConfig } from "@/lib/db/settings";
import { fetchSiteSignals } from "@/lib/sources/website";
import { fetchFeed } from "@/lib/sources/googleNews";
import { classifyAndRecordHeadline } from "@/lib/triggers/sweep";

const fresh = (d: string | null) => { if (!d) return false; const a = (Date.now() - new Date(d).getTime()) / 86_400_000; return a >= 0 && a < 180; };

/**
 * Website watch (FREE) over claimable leads, three jobs per company in one pass:
 *  1) GROWTH PHRASES — diff the set on their site vs last check; fire on NEW phrases
 *     (new office/location, new division/subsidiary, an acquisition they made).
 *  2) PARENT-COMPANY — detect "subsidiary of / division of / acquired by X"; flag it,
 *     and AUTO-DISMISS high-confidence subsidiaries (toggle: app_config.parent_autodismiss).
 *  3) NEWSROOM RSS — parse their own news/blog feed and run each item through the same
 *     event classifier as Google News (it's their feed, so no name-match needed).
 * First sight of the growth set = baseline (store, no fire).
 */
export async function sweepWebsites(limit = 120, opts: { offset?: number; scope?: "claimable" | "tail" } = {}): Promise<{ checked: number; changed: number; triggered: number; parents: number; dismissed: number }> {
  const companies = await pickSitesForRotation(limit, opts.offset ?? 0, opts.scope ?? "claimable");
  const stats = { checked: 0, changed: 0, triggered: 0, parents: 0, dismissed: 0 };
  let autodismiss = true;
  try { autodismiss = (await getAppConfig()).parent_autodismiss; } catch { /* default true */ }

  // Time-boxed: setSiteChecked already stamps per-company, so stopping early just
  // leaves the rest for the next wave — never a lost wave.
  const deadline = Date.now() + 48_000;
  const BATCH = 8;
  for (let i = 0; i < companies.length; i += BATCH) {
    if (Date.now() > deadline) break;
    stats.checked += Math.min(BATCH, companies.length - i);
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        const scan = await fetchSiteSignals(c.domain);
        let touched = false;

        // 1) growth-phrase diff
        const current = [...new Set(scan.growth.map((h) => h.label))].sort();
        const fingerprint = current.join("|");
        const priorSet = new Set((c.site_hash ?? "").split("|").filter(Boolean));
        const isBaseline = c.site_checked_at == null && c.site_hash == null;
        await setSiteChecked(c.id, fingerprint);
        if (!isBaseline) {
          for (const h of scan.growth.filter((x) => !priorSet.has(x.label))) {
            stats.changed++;
            const url = `https://${c.domain.replace(/\/+$/, "")}/#${encodeURIComponent(h.label)}`;
            if (await recordTrigger(c.id, { type: h.type, summary: `Website update — ${h.label}`, source_name: "Company website", source_url: url, signal_date: new Date().toISOString() })) { stats.triggered++; touched = true; }
          }
        }

        // 2) parent-company
        if (scan.parent) {
          await setParent(c.id, scan.parent.name, scan.parent.confidence);
          stats.parents++;
          if (scan.parent.confidence === "high" && autodismiss) { await setCompaniesStatus([c.id], "dismissed"); stats.dismissed++; }
        }

        // 3) newsroom/blog RSS → same event classifier (own feed → no name-match needed)
        if (scan.feedUrl) {
          for (const it of await fetchFeed(scan.feedUrl, 8)) {
            if (!fresh(it.signal_date)) continue;
            if (await classifyAndRecordHeadline(c, it, { llm: true, requireNameMatch: false })) { stats.triggered++; touched = true; }
          }
        }

        // 4) FINANCE HIRING — open finance roles on their OWN careers page (free; works
        // where ATS aggregators are empty on this small-firm TAM). Fires on detection,
        // deduped per role via source_url. A finance req = scaling finance in-house now.
        for (const role of scan.financeRoles) {
          const url = `https://${c.domain.replace(/\/+$/, "")}/careers#${encodeURIComponent(role)}`;
          if (await recordTrigger(c.id, { type: "finance_hire", summary: `Hiring for ${role} (own careers page) — scaling finance in-house`, source_name: "Careers page", source_url: url, signal_date: new Date().toISOString() })) { stats.triggered++; touched = true; }
        }

        if (touched) await recomputePriority(c.id);
      } catch { /* per-company isolated */ }
    }));
  }
  return stats;
}
