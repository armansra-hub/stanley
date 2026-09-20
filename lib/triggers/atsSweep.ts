import "server-only";
import { rotationBatches } from "./rotationBatches";
import { pickAtsForRotation, setAtsChecked, setErpFlags, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { detectAtsResult, fetchAtsJobsBatch, scanJob, type AtsType } from "@/lib/sources/ats";
import { isCareerEvidenceUrl, isFinanceHireEligible } from "@/lib/triggers/signalIntegrity";
import { enqueueObservation } from "@/lib/intelligence/observations";
import { readSourceState, writeSourceState } from "@/lib/intelligence/sourceState";
import { applyAtsBatch, enqueuePendingAtsPatterns, atsJobIdentity, prepareAtsJob, readAtsKnownJobs, readAtsScan } from "@/lib/intelligence/atsLifecycle";
import { atsRevisitOutcome, nextRevisit } from "./adaptiveRevisit";

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
  const stats = { checked: 0, detected: 0, with_board: 0, finance_triggers: 0, erp_triggers: 0, already_on_erp: 0 };
  const touched = new Set<string>();
  const intelligenceEnabled = process.env.STANLEY_INTELLIGENCE_ENABLED === "true";

  for await (const slice of rotationBatches(pickAtsForRotation, { limit, batchSize: 12, offset: opts.offset })) {
    stats.checked += slice.length;
    await Promise.all(slice.map(async (c) => {
      try {
        let type = c.ats_type as AtsType | "none" | null;
        let token = c.ats_token as string | null;

        // A negative detection is not permanent. The fair rotation supplies the
        // revisit interval without stamping the whole TAM or creating a second job.
        if (!type || type === "none" || !token) {
          const detection = await detectAtsResult(c.domain);
          if (detection.board) {
            type = detection.board.type; token = detection.board.token; stats.detected++;
            await setAtsChecked(c.id, { ats_type: type, ats_token: token });
          } else {
            if (intelligenceEnabled) await writeSourceState(c.id, "ats:discovery", {
              cursor: { detection: detection.status, unsupportedProvider: detection.unsupportedProvider ?? null },
              complete: detection.status === "none", status: detection.status === "none" ? "empty" : detection.status === "unsupported" ? "unsupported" : "unavailable",
              successful: detection.status !== "unavailable", details: { urlOutcomes: detection.outcomes },
              nextAttemptAt: new Date(Date.now() + (detection.status === "unavailable" ? 2 : 24) * 3600000).toISOString(),
              ...(detection.status === "unavailable" ? { error: "ATS discovery unavailable; no absence inferred" } : {}),
            });
            if (detection.status === "none") await setAtsChecked(c.id, { ats_type: "none", ats_token: null });
            return;
          }
        } else {
          await setAtsChecked(c.id, {}); // just bump ats_checked_at (re-poll rotation)
        }
        if (!type || !token) return;
        stats.with_board++;

        // A finance role at a record-dead or finance-services company is not an
        // in-house-finance readiness signal. We still stamp/detect its board, but
        // do not infer triggers or an incumbent from its delivery-team postings.
        if (c.record_dead === true) return;
        const financeEligible = isFinanceHireEligible(c);

        // 2) Poll + scan.
        const sourceKey = `ats:${type}:${token}`;
        const sourceState = intelligenceEnabled ? await readSourceState(c.id, sourceKey) : null;
        const cursor = intelligenceEnabled ? await readAtsScan(c.id, sourceKey) : { scanId: null, offset: 0 };
        const offset = cursor.offset;
        const batch = await fetchAtsJobsBatch(type as AtsType, token, { offset, maxJobs: intelligenceEnabled ? 150 : 60 });
        const jobs = batch.jobs;
        const knownJobs = intelligenceEnabled ? await readAtsKnownJobs(c.id, sourceKey, jobs.filter((job) => isCareerEvidenceUrl(job.url))) : new Map();
        const preparedJobs = [];
        let incumbent: "quickbooks" | "erp" | null = null;
        let financeCount = 0;
        for (const j of jobs) {
          if (!isCareerEvidenceUrl(j.url)) continue;
          const scan = scanJob(j.title, j.description);
          if (intelligenceEnabled) {
            const known = knownJobs.get(atsJobIdentity(sourceKey, j));
            const prepared = prepareAtsJob(sourceKey, j, known);
            preparedJobs.push(prepared);
            if (!known || known.content_hash !== prepared.content_hash) await enqueueObservation({
              companyId: c.id, companyName: c.name, companyDomain: c.domain,
              sourceKind: "job", sourceUrl: j.url, title: j.title,
              text: `${j.title}${j.location ? ` — ${j.location}` : ""}\n${j.description}`,
              eventDate: j.date,
              metadata: { atsType: type, atsToken: token, atsJobKey: prepared.job_key, atsRoleCategories: prepared.categories,
                listingChange: known ? "changed" : "first_observed", isClientPlacement: scan.isClientPlacement,
                jobDateKind: type === "greenhouse" ? "updated" : "published_or_created", descriptionAvailable: Boolean(j.description) },
            });
          }
          // Recruiting delivery work and client placements are not an in-house
          // incumbent. New operating-role evidence stays in the research lane.
          if (!financeEligible || scan.isClientPlacement || (["jazzhr", "jobvite", "workday", "icims", "adp"].includes(type) && !j.description.trim())) continue;
          if (scan.isFinance) {
            if (scan.incumbent === "quickbooks") incumbent = "quickbooks";
            else if (scan.incumbent === "erp" && incumbent !== "quickbooks") incumbent = "erp";
          }
          if (!scan.isFinance || financeCount >= 5) continue;
          financeCount++;
          const date = j.date ?? new Date().toISOString();
          if (scan.painHits.length > 0) {
            if (await recordTrigger(c.id, { type: "erp_tech", summary: `Hiring ${j.title}${j.location ? ` (${j.location})` : ""} — JD describes: ${scan.painHits.join(", ")}`, source_name: "Job posting", source_url: j.url, signal_date: date })) { stats.erp_triggers++; touched.add(c.id); }
          } else {
            if (await recordTrigger(c.id, { type: "finance_hire", summary: `Hiring ${j.title}${j.location ? ` (${j.location})` : ""} (in-house finance)`, source_name: "Job posting", source_url: j.url, signal_date: date })) { stats.finance_triggers++; touched.add(c.id); }
          }
        }
        if (incumbent) {
          await setErpFlags(c.id, { erp_incumbent: incumbent });
          if (incumbent === "erp") stats.already_on_erp++;
          touched.add(c.id); // recompute (QB boosts, ERP suppresses)
        }
        if (intelligenceEnabled) {
          const lifecycle = await applyAtsBatch(c.id, sourceKey, cursor, batch, preparedJobs);
          if (!lifecycle.accepted) return; // another invocation advanced this exact cursor
          await enqueuePendingAtsPatterns(c, sourceKey, type as AtsType, token);
          await writeSourceState(c.id, sourceKey, {
            cursor: {
              ...(lifecycle.nextOffset == null ? {} : { offset: lifecycle.nextOffset, scanId: lifecycle.complete ? null : lifecycle.scanId }),
              revisit: nextRevisit(sourceState?.cursor?.revisit, atsRevisitOutcome(lifecycle.complete === true, lifecycle.summary)),
            },
            complete: lifecycle.complete === true,
            status: batch.status === "unavailable" ? "unavailable" : lifecycle.complete ? (jobs.length ? "complete" : "empty") : "partial",
            successful: batch.status !== "unavailable",
            details: { providerStatus: batch.status, returnedJobs: jobs.length, offset, restart: lifecycle.restart === true,
              coverageKind: batch.coverageKind ?? "provider_api", descriptionsFetched: batch.descriptionsFetched ?? null, descriptionsUnavailable: batch.descriptionsUnavailable ?? null },
            ...(lifecycle.restart ? { error: "ATS board changed during pagination; restarting complete scan" } : {}),
            ...(batch.status === "unavailable" ? { error: "ATS retrieval unavailable; prior offset retained" } : {}),
          });
        }
      } catch { /* per-company isolated */ }
      finally {
        // Detection/network failures still advance the fair rotation; retry after
        // the rest of the TAM instead of starving every later row.
        await setAtsChecked(c.id, {});
      }
    }));
  }

  for (const id of touched) await recomputePriority(id);
  return stats;
}
