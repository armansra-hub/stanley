import "server-only";
import { markSiteAttempted, pickSitesForRotation, setSiteChecked, setParent, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { setCompaniesStatus } from "@/lib/db/companies";
import { getAppConfig } from "@/lib/db/settings";
import { fetchSiteSignals } from "@/lib/sources/website";
import { fetchFeed } from "@/lib/sources/googleNews";
import { classifyAndRecordHeadline } from "@/lib/triggers/sweep";
import { isFinanceHireEligible, isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";
import { rotationBatches } from "./rotationBatches";
import { HEADLINE_CLASSIFIER_BATCH_BUDGET_MS } from "./classify";
import { enqueueObservation, intelligenceEnabled } from "@/lib/intelligence/observations";
import { readSourceState, writeSourceState } from "@/lib/intelligence/sourceState";
import { companyPageUrl, sameCompanySite, sitePageEvidence } from "@/lib/sources/siteDiscovery";
import { fetchPublicHttpText } from "./urlSafety";
import { nextRevisit, websiteChangeHistory } from "./adaptiveRevisit";
import { publicResponseOutcome, sourceErrorCode, type SourceUrlOutcome } from "@/lib/sources/outcomes";

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
  const stats = { checked: 0, changed: 0, triggered: 0, parents: 0, dismissed: 0 };
  const captureEnabled = intelligenceEnabled();
  let autodismiss = true;
  try { autodismiss = (await getAppConfig()).parent_autodismiss; } catch { /* default true */ }

  for await (const slice of rotationBatches(
    (n, offset) => pickSitesForRotation(n, offset, opts.scope ?? "claimable"),
    { limit, batchSize: 12, offset: opts.offset },
  )) {
    // This includes the site's/feed's fetch time. Sequential headline verifier
    // calls share the remainder; expiration still queues candidates for the
    // unchanged independent final review and never publishes by fallback.
    const classifierDeadlineMs = Date.now() + HEADLINE_CLASSIFIER_BATCH_BUDGET_MS;
    stats.checked += slice.length;
    await Promise.all(slice.map(async (c) => {
      try {
        const sourceKey = "website";
        let state: Awaited<ReturnType<typeof readSourceState>> | null = null;
        let stateReadFailed = false;
        if (captureEnabled) {
          try { state = await readSourceState(c.id, sourceKey); }
          catch { stateReadFailed = true; }
        }
        const base = `https://${c.domain}`;
        const urls = (value: unknown): string[] => Array.isArray(value)
          ? [...new Set(value.filter((url): url is string => typeof url === "string" && url.length <= 2048).map(url => companyPageUrl(url, base)).filter((url): url is string => Boolean(url)))].slice(0, 200) : [];
        const knownUrls = urls(state?.cursor?.knownUrls);
        const priorPending = urls(state?.cursor?.pendingUrls);
        const baseline = captureEnabled && !state?.cursor?.baselineCapturedAt && !urls(state?.cursor?.verifiedUrls).length;
        const scan = captureEnabled
          ? await fetchSiteSignals(c.domain, c.name, { knownUrls, maxPages: baseline ? 2 : 5, mode: baseline ? "baseline" : "deep" })
          : await fetchSiteSignals(c.domain, c.name);
        let captureFailed = stateReadFailed;
        const fetchedPending: string[] = [];
        const failedPending: string[] = [...(scan.coverage.failedUrls ?? [])];
        const urlOutcomes: SourceUrlOutcome[] = [...(scan.coverage.urlOutcomes ?? [])];
        const savedUrls: string[] = [];
        if (captureEnabled) {
          // Reserve three slots for the prior backlog. Homepage discovery alone
          // must not keep selecting the same first few newsroom links forever.
          const pending = (priorPending.length ? priorPending : knownUrls)
            .filter(url => !scan.coverage.attemptedUrls.includes(url)).slice(0, baseline ? 0 : 3);
          await Promise.all(pending.map(async url => {
            try {
              const response = await fetchPublicHttpText(url, { timeoutMs: 3500, maxBytes: 1_000_000 });
              const outcome = sameCompanySite(response.finalUrl, base) ? publicResponseOutcome(url, response.status, response.body)
                : { url, outcome: "unavailable" as const, code: "cross_company_redirect" as const };
              urlOutcomes.push(outcome);
              if ((response.status === 404 || response.status === 410) && sameCompanySite(response.finalUrl, base)) {
                fetchedPending.push(url); return; // confirmed absence is not an endless retry failure
              }
              if (outcome.outcome !== "success") { failedPending.push(url); return; }
              const page = sitePageEvidence(response.body, response.finalUrl);
              if (!page.text.trim()) throw new Error("Website page has no evidence");
              if (!scan.pages.some(existing => existing.url === page.url)) scan.pages.push(page);
              fetchedPending.push(url);
            } catch (error) { failedPending.push(url); urlOutcomes.push({ url, outcome: "unavailable", code: sourceErrorCode(error) }); }
          }));
          if (!scan.pages.some(page => page.text.trim())) captureFailed = true;
          for (const page of scan.pages) {
            if (!page.text.trim()) continue;
            try {
              const published = [...new Set(page.sourceDates.filter(date => date.kind === "published").map(date => date.value))];
              const stored = await enqueueObservation({
                companyId: c.id, companyName: c.name, companyDomain: c.domain,
                sourceKind: "website", sourceUrl: page.url, title: page.title || `${c.name} company website`,
                text: page.text, eventDate: published.length === 1 ? published[0] : null,
                metadata: { sourceDates: page.sourceDates, meaningfulContentHash: page.contentHash, textTruncated: page.truncated,
                  eventDateBasis: published.length === 1 ? "page_publication" : "unknown", collectionMode: baseline ? "baseline" : "deep" },
              });
              if (!stored) captureFailed = true;
              else savedUrls.push(page.url);
            } catch { captureFailed = true; }
          }
        }
        let touched = false;

        const current = [...new Set(scan.growth.map((h) => h.label))].sort();
        const fingerprint = current.join("|");
        const priorSet = new Set((c.site_hash ?? "").split("|").filter(Boolean));
        if (!captureEnabled) await setSiteChecked(c.id, fingerprint);
        stats.changed += scan.growth.filter((x) => !priorSet.has(x.label)).length;

        if (scan.parent) {
          await setParent(c.id, scan.parent.name, scan.parent.confidence);
          stats.parents++;
          if (scan.parent.confidence === "high" && autodismiss) { await setCompaniesStatus([c.id], "dismissed"); stats.dismissed++; }
        }

        // Real newsroom/blog items retain the exact source page and the existing
        // event verifier, including the acquirer-position check for M&A.
        if (scan.feedUrl && !baseline) {
          const feedItems = (await fetchFeed(scan.feedUrl, captureEnabled ? 12 : 8)).filter(it => fresh(it.signal_date));
          if (captureEnabled) {
            for (let from = 0; from < feedItems.length; from += 4) {
              const results = await Promise.allSettled(feedItems.slice(from, from + 4).map(it => classifyAndRecordHeadline(c, it, { llm: true, requireNameMatch: false, classifierDeadlineMs })));
              for (const result of results) {
                if (result.status === "rejected") captureFailed = true;
                else if (result.value) { stats.triggered++; touched = true; }
              }
            }
          } else {
            for (const it of feedItems) {
              if (await classifyAndRecordHeadline(c, it, { llm: true, requireNameMatch: false, classifierDeadlineMs })) { stats.triggered++; touched = true; }
            }
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
        if (captureEnabled) {
          if (stateReadFailed) return; // preserve an unknown durable cursor
          const allKnown = urls([...knownUrls, ...scan.discoveredUrls]);
          const verifiedUrls = urls([...urls(state?.cursor?.verifiedUrls), ...savedUrls]);
          const attempted = new Set([...scan.coverage.attemptedUrls, ...fetchedPending]);
          const newlyDiscovered = scan.discoveredUrls.filter(url => !knownUrls.includes(url));
          const pending = captureFailed
            ? urls([...priorPending, ...scan.discoveredUrls])
            : urls([...priorPending.filter(url => !attempted.has(url)), ...newlyDiscovered.filter(url => !attempted.has(url)), ...failedPending]);
          const incomplete = captureFailed || failedPending.length > 0;
          const complete = !incomplete && pending.length === 0;
          const changes = websiteChangeHistory(state?.cursor?.pageHashes, scan.pages.filter(page => page.text.trim()));
          const changedSinceComplete = changes.outcome === "changed" || state?.cursor?.changedSinceComplete === true || touched;
          const revisit = nextRevisit(state?.cursor?.revisit,
            !complete ? "incomplete" : changedSinceComplete ? "changed" : changes.outcome);
          const consecutiveFailures = savedUrls.length ? 0 : Math.min(8, Number(state?.cursor?.consecutiveFailures ?? 0) + 1);
          const warningCodes = [...new Set(urlOutcomes.filter(outcome => outcome.outcome === "unavailable").map(outcome => outcome.code ?? "network"))];
          await writeSourceState(c.id, sourceKey, {
            cursor: { knownUrls: allKnown, verifiedUrls, pendingUrls: pending, attemptedPages: scan.coverage.attemptedUrls.length + fetchedPending.length + failedPending.length, retainedPages: scan.pages.length,
              baselineCapturedAt: state?.cursor?.baselineCapturedAt ?? (savedUrls.length ? new Date().toISOString() : null),
              collectionMode: baseline ? "baseline" : "deep", consecutiveFailures, urlOutcomes: urlOutcomes.slice(0, 16),
              pageHashes: captureFailed ? state?.cursor?.pageHashes ?? {} : changes.hashes,
              changedSinceComplete: !complete && changedSinceComplete, revisit },
            complete,
            status: savedUrls.length ? (complete ? "complete" : "partial") : "unavailable", successful: savedUrls.length > 0,
            details: { urlOutcomes: urlOutcomes.slice(0, 16), savedPages: savedUrls.length, pendingPages: pending.length, storageError: captureFailed },
            nextAttemptAt: consecutiveFailures ? new Date(Date.now() + Math.min(24, 2 ** (consecutiveFailures - 1)) * 3600000).toISOString() : null,
            ...(incomplete ? { error: warningCodes.length ? `Website: ${warningCodes.join(", ")}` : captureFailed ? "Website evidence capture/storage incomplete" : "Website depth pending" } : {}),
          });
          if (!captureFailed) await setSiteChecked(c.id, fingerprint);
        }
      } catch { /* per-company isolated */ }
      finally {
        // A permanently broken domain must not monopolize the oldest-first cursor.
        await markSiteAttempted(c.id).catch(() => {});
      }
    }));
  }
  return stats;
}
