import "server-only";
import { markSiteAttempted, pickSitesForRotation, setSiteChecked, setParent, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { setCompaniesStatus } from "@/lib/db/companies";
import { getAppConfig } from "@/lib/db/settings";
import { fetchSiteSignals } from "@/lib/sources/website";
import { fetchFeed } from "@/lib/sources/googleNews";
import { classifyAndRecordHeadline } from "@/lib/triggers/sweep";
import { isFinanceHireEligible, isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";

const fresh = (d: string | null) => { if (!d) return false; const a = (Date.now() - new Date(d).getTime()) / 86_400_000; return a >= 0 && a < 180; };

/**
 * Website watch (FREE) over claimable leads:
 *  1) retain a growth-phrase fingerprint for change detection only;
 *  2) detect explicit parent-company language;
 *  3) publish verified newsroom/feed events with their real article URLs;
 *  4) publish finance openings from their real careers pages.
 *
 * Homepage/about-page phrases never publish M&A or expansion triggers. They do not
 * provide a canonical evidence page and previously created fabricated /# links.
 */
export async function sweepWebsites(limit = 120, opts: { offset?: number; scope?: "claimable" | "tail" } = {}): Promise<{ checked: number; changed: number; triggered: number; parents: number; dismissed: number }> {
  const companies = await pickSitesForRotation(limit, opts.offset ?? 0, opts.scope ?? "claimable");
  const stats = { checked: 0, changed: 0, triggered: 0, parents: 0, dismissed: 0 };
  let autodismiss = true;
  try { autodismiss = (await getAppConfig()).parent_autodismiss; } catch { /* default true */ }

  const deadline = Date.now() + 48_000;
  const BATCH = 8;
  for (let i = 0; i < companies.length; i += BATCH) {
    if (Date.now() > deadline) break;
    stats.checked += Math.min(BATCH, companies.length - i);
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        const scan = await fetchSiteSignals(c.domain, c.name);
        let touched = false;

        const current = [...new Set(scan.growth.map((h) => h.label))].sort();
        const fingerprint = current.join("|");
        const priorSet = new Set((c.site_hash ?? "").split("|").filter(Boolean));
        await setSiteChecked(c.id, fingerprint);
        stats.changed += scan.growth.filter((x) => !priorSet.has(x.label)).length;

        if (scan.parent) {
          await setParent(c.id, scan.parent.name, scan.parent.confidence);
          stats.parents++;
          if (scan.parent.confidence === "high" && autodismiss) { await setCompaniesStatus([c.id], "dismissed"); stats.dismissed++; }
        }

        // Real newsroom/blog items retain the exact source page and the existing
        // event verifier, including the acquirer-position check for M&A.
        if (scan.feedUrl) {
          for (const it of await fetchFeed(scan.feedUrl, 8)) {
            if (!fresh(it.signal_date)) continue;
            if (await classifyAndRecordHeadline(c, it, { llm: true, requireNameMatch: false })) { stats.triggered++; touched = true; }
          }
        }

        for (const hit of scan.financeRoles) {
          if (!isFinanceHireEligible(c) || !isCareerEvidenceUrl(hit.url)) continue;
          if (await recordTrigger(c.id, {
            type: "finance_hire",
            summary: `Hiring ${hit.role} — “${hit.snippet.slice(0, 150)}”`,
            source_name: "Careers page", source_url: hit.url, signal_date: new Date().toISOString(),
          })) { stats.triggered++; touched = true; }
        }

        if (touched) await recomputePriority(c.id);
      } catch { /* per-company isolated */ }
      finally {
        // A permanently broken domain must not monopolize the oldest-first cursor.
        await markSiteAttempted(c.id).catch(() => {});
      }
    }));
  }
  return stats;
}
