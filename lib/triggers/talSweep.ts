import "server-only";
import { listTalCompanies, setTalAlert, recomputePriority, markChecked } from "@/lib/db/triggers";
import { checkCompanyNews } from "@/lib/triggers/sweep";
import { withServiceDeadline } from "@/lib/supabase/server";
import { HEADLINE_CLASSIFIER_BATCH_BUDGET_MS } from "./classify";
import { newSweepOutcomes, sweepError, type SweepOutcome } from "./sweepOutcomes";

export const TAL_NEWS_BUDGET_MS = 240_000;
export const TAL_NEWS_FINAL_BATCH_HEADROOM_MS = 60_000;

/**
 * Bounded priority supplement over the existing claimed TAL membership. The
 * loader orders oldest news timestamps first; the ordinary TAM sweep also moves
 * those timestamps, so a bounded invocation is not proof of full TAL coverage.
 * Persist each finished batch's alerts before admitting more work. Signal
 * identity/publication rules remain in the shared company-news collector.
 */
export async function sweepTalNews() {
  const deadline = Date.now() + TAL_NEWS_BUDGET_MS;
  return withServiceDeadline(deadline, async () => {
    const companies = await listTalCompanies();
    const stats = { ...newSweepOutcomes(), checked: 0, new_triggers: 0, alerted: 0 };
    const failedAlertCompanyIds: string[] = [];
    // Match the main news collector's provider-pressure bound: at most eight
    // Google feed queries and sixteen publisher-body reads in flight.
    const BATCH = 4;
    for (let i = 0; i < companies.length; i += BATCH) {
      if (Date.now() >= deadline - TAL_NEWS_FINAL_BATCH_HEADROOM_MS) break;
      const alertIds: string[] = [];
      const completed: string[] = [];
      const classifierDeadlineMs = Math.min(deadline, Date.now() + HEADLINE_CLASSIFIER_BATCH_BUDGET_MS);
      await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
        let outcome: SweepOutcome = "failed";
        stats.attempted++;
        stats.checked++;
        try {
          const n = await checkCompanyNews(c, { llm: true, classifierDeadlineMs,
            onOutcome: value => { outcome = value; },
            onError: (stage, error) => sweepError(stats, "tal-news", stage, error, c.id),
          });
          if (n > 0) {
            stats.new_triggers += n;
            alertIds.push(c.id);
            try { await recomputePriority(c.id); }
            catch (error) { sweepError(stats, "tal-news", "priority", error, c.id); }
          }
          if ((outcome as SweepOutcome) === "succeeded") completed.push(c.id);
        } catch (error) { sweepError(stats, "tal-news", "collection", error, c.id); }
        finally { stats[outcome]++; }
      }));
      let completionIds = completed;
      try { await setTalAlert(alertIds); stats.alerted += alertIds.length; }
      catch (error) {
        // News deduplication may suppress these IDs on a later pass. Retain
        // exact recovery targets in the source event; do not blindly resend.
        failedAlertCompanyIds.push(...alertIds);
        const failedAlerts = new Set(alertIds);
        completionIds = completed.filter(id => !failedAlerts.has(id));
        sweepError(stats, "tal-news", "alert_write", error);
      }
      try { await markChecked(completionIds); }
      catch (error) {
        stats.succeeded -= completionIds.length; stats.failed += completionIds.length;
        sweepError(stats, "tal-news", "completion_stamp", error);
      }
    }
    const remaining = companies.length - stats.attempted;
    return { ...stats, eligible: companies.length, remaining, failedAlertCompanyIds,
      complete: remaining === 0 && stats.succeeded === stats.attempted && stats.error_count === 0,
      stopReason: remaining ? "budget_reached" : "worklist_exhausted" };
  });
}
