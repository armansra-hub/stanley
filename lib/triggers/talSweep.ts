import "server-only";
import { listTalCompanies, setTalAlert, recomputePriority } from "@/lib/db/triggers";
import { checkCompanyNews } from "@/lib/triggers/sweep";

/**
 * Daily HIGHEST-PRIORITY news sweep over the AE's TAL (claimed accounts). Runs the
 * same free Google-News check as the base sweep, but over EVERY claimed account
 * every day (vs the ~2-day cycle for the rest). Any claimed account that picks up a
 * NEW signal is flagged `tal_alert` → the in-app notification (the only one the AE
 * wants). Boost-only; never creates a company.
 */
export async function sweepTalNews(): Promise<{ checked: number; new_triggers: number; alerted: number }> {
  const companies = await listTalCompanies();
  const stats = { checked: companies.length, new_triggers: 0, alerted: 0 };
  const alertIds: string[] = [];

  const BATCH = 20;
  for (let i = 0; i < companies.length; i += BATCH) {
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        const n = await checkCompanyNews(c, { llm: true });
        if (n > 0) { stats.new_triggers += n; alertIds.push(c.id); await recomputePriority(c.id); }
      } catch { /* source-isolated */ }
    }));
  }
  await setTalAlert(alertIds);
  stats.alerted = alertIds.length;
  return stats;
}
