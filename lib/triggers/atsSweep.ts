import "server-only";
import { pickAtsForRotation, setAtsChecked, setErpFlags, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { detectAts, fetchAtsJobs, scanJob, type AtsType } from "@/lib/sources/ats";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * ATS sweep (FREE) — the ERP-readiness workhorse. For the next batch of base
 * companies (longest-since-checked, NetSuite-TAM first):
 *   • if we don't know their job board yet, DETECT it from their careers page;
 *   • POLL the board and scan finance/accounting postings for ERP-pain language.
 * A finance role → `finance_hire`; a finance role whose JD reveals pain
 * (QuickBooks, manual/Excel, ERP implementation, ASC 606, month-end close,
 * multi-entity) → `erp_tech` (the strongest signal). We also record the company's
 * accounting incumbent: QuickBooks-class boosts the readiness score; an existing
 * ERP (NetSuite/Intacct/…) suppresses the lead (not a prospect).
 */
export async function sweepAts(limit = 120, opts: { offset?: number } = {}): Promise<{ checked: number; detected: number; with_board: number; finance_triggers: number; erp_triggers: number; already_on_erp: number }> {
  const companies = await pickAtsForRotation(limit, opts.offset ?? 0);
  const stats = { checked: companies.length, detected: 0, with_board: 0, finance_triggers: 0, erp_triggers: 0, already_on_erp: 0 };
  const touched = new Set<string>();

  const BATCH = 12;
  for (let i = 0; i < companies.length; i += BATCH) {
    await Promise.all(companies.slice(i, i + BATCH).map(async (c) => {
      try {
        let type = c.ats_type as AtsType | "none" | null;
        let token = c.ats_token as string | null;

        // 1) Detect the board once (companies with no ats_type yet).
        if (!type) {
          const found = await detectAts(c.domain);
          if (found) { type = found.type; token = found.token; stats.detected++; }
          else type = "none";
          await setAtsChecked(c.id, { ats_type: type, ats_token: token ?? null });
        } else {
          await setAtsChecked(c.id, {}); // just bump ats_checked_at (re-poll rotation)
        }
        if (type === "none" || !token) return;
        stats.with_board++;

        // 2) Poll + scan.
        const jobs = await fetchAtsJobs(type as AtsType, token);
        let incumbent: "quickbooks" | "erp" | null = null;
        let financeCount = 0;
        for (const j of jobs) {
          const scan = scanJob(j.title, j.description);
          if (scan.incumbent === "quickbooks") incumbent = "quickbooks";
          else if (scan.incumbent === "erp" && incumbent !== "quickbooks") incumbent = "erp";
          if (!scan.isFinance || financeCount >= 5) continue; // cap finance triggers/company
          financeCount++;
          const date = j.date ?? new Date().toISOString();
          if (scan.painHits.length > 0) {
            if (await recordTrigger(c.id, { type: "erp_tech", summary: `Hiring ${j.title}${j.location ? ` (${j.location})` : ""} — JD signals ERP pain: ${scan.painHits.join(", ")}`, source_name: "Job posting", source_url: j.url, signal_date: date })) { stats.erp_triggers++; touched.add(c.id); }
          } else {
            if (await recordTrigger(c.id, { type: "finance_hire", summary: `Hiring ${j.title}${j.location ? ` (${j.location})` : ""} (in-house finance)`, source_name: "Job posting", source_url: j.url, signal_date: date })) { stats.finance_triggers++; touched.add(c.id); }
          }
        }
        if (incumbent) {
          await setErpFlags(c.id, { erp_incumbent: incumbent });
          if (incumbent === "erp") stats.already_on_erp++;
          touched.add(c.id); // recompute (QB boosts, ERP suppresses)
        }
      } catch { /* per-company isolated */ }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  return stats;
}
