import { assertFiniteCollection, finiteCollectionAccounting, type FiniteCollectionScope, type FiniteCollectionResult } from "./finiteCollection";
import "server-only";
import { markSiteAttempted, pickSitesForRotation, setSiteChecked, setParent, recordTrigger, recomputePriority } from "@/lib/db/triggers";
import { setCompaniesStatus } from "@/lib/db/companies";
import { getAppConfig } from "@/lib/db/settings";
import { fetchSiteSignals, readWebsiteCache, type WebsiteCacheEntry } from "@/lib/sources/website";
import { fetchFeedResult, readNewsFeedCache } from "@/lib/sources/googleNews";
import { fetchConditionalText, responseValidators } from "@/lib/sources/conditionalFetch";
import { classifyAndRecordHeadline } from "@/lib/triggers/sweep";
import { isFinanceHireEligible, isCareerEvidenceUrl } from "@/lib/triggers/signalIntegrity";
import { rotationBatches } from "./rotationBatches";
import { HEADLINE_CLASSIFIER_BATCH_BUDGET_MS } from "./classify";
import { enqueueObservation, intelligenceEnabled } from "@/lib/intelligence/observations";
import { readSourceState, writeSourceState } from "@/lib/intelligence/sourceState";
import { companyPageUrl, discoverSiteLinks, sameCompanySite, sitePageEvidence } from "@/lib/sources/siteDiscovery";
import { nextRevisit, websiteChangeHistory } from "./adaptiveRevisit";
import { publicResponseOutcome, sourceErrorCode, type SourceUrlOutcome } from "@/lib/sources/outcomes";
import { newSweepOutcomes, sweepError, type SweepOutcome, type SweepOutcomes } from "./sweepOutcomes";

const fresh = (d: string | null) => { if (!d) return false; const a = (Date.now() - new Date(d).getTime()) / 86_400_000; return a >= 0 && a < 180; };

// A final site/backlog/feed batch can use ~95 seconds of network time. Stop
// reserving at 150 seconds to leave 125 seconds before the dispatcher's timeout.
export const WEBSITE_ADMISSION_BUDGET_MS = 150_000;

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
export async function sweepWebsites(limit = 120, opts: { offset?: number; scope?: "claimable" | "tail"; sourceOnly?: boolean; collection?: FiniteCollectionScope } = {}): Promise<FiniteCollectionResult & SweepOutcomes & { checked: number; changed: number; triggered: number; parents: number; dismissed: number; sourceOnly: boolean }> {
  assertFiniteCollection(opts.collection, { ...opts, limit });
  const accounting = finiteCollectionAccounting(opts.collection);
  const stats = { ...newSweepOutcomes(), checked: 0, changed: 0, triggered: 0, parents: 0, dismissed: 0, sourceOnly: opts.sourceOnly === true };
  const captureEnabled = intelligenceEnabled();
  if (opts.sourceOnly && !captureEnabled) throw new Error("Source-only website requires evidence capture");
  let autodismiss = true;
  if (!opts.sourceOnly) {
    try { autodismiss = (await getAppConfig()).parent_autodismiss; } catch (error) { sweepError(stats, "website", "config_read", error); }
  }

  for await (const slice of rotationBatches(
    (n, offset) => opts.collection ? pickSitesForRotation(n, offset, opts.scope ?? "claimable", opts.collection) : pickSitesForRotation(n, offset, opts.scope ?? "claimable"),
    { limit, batchSize: 12, offset: opts.offset, budgetMs: WEBSITE_ADMISSION_BUDGET_MS },
  )) {
    // This includes the site's/feed's fetch time. Sequential headline verifier
    // calls share the remainder; expiration still queues candidates for the
    // unchanged independent final review and never publishes by fallback.
    const classifierDeadlineMs = Date.now() + HEADLINE_CLASSIFIER_BATCH_BUDGET_MS;
    stats.checked += slice.length;
    await Promise.all(slice.map(async (c) => {
      let outcome: SweepOutcome = "failed";
      stats.attempted++;
      try {
        const sourceKey = "website";
        let state: Awaited<ReturnType<typeof readSourceState>> | null = null;
        let stateReadFailed = false;
        if (captureEnabled) {
          try { state = await readSourceState(c.id, sourceKey); }
          catch (error) { stateReadFailed = true; sweepError(stats, "website", "state_read", error, c.id); }
        }
        const base = `https://${c.domain}`;
        const urls = (value: unknown): string[] => Array.isArray(value)
          ? [...new Set(value.filter((url): url is string => typeof url === "string" && url.length <= 2048).map(url => companyPageUrl(url, base)).filter((url): url is string => Boolean(url)))].slice(0, 200) : [];
        const knownUrls = urls(state?.cursor?.knownUrls);
        const priorPending = urls(state?.cursor?.pendingUrls);
        const priorCache = readWebsiteCache(state?.cursor?.httpCache, base);
        const baseline = captureEnabled && !state?.cursor?.baselineCapturedAt && !urls(state?.cursor?.verifiedUrls).length;
        const scan = captureEnabled
          ? await fetchSiteSignals(c.domain, c.name, { knownUrls, httpCache: priorCache, maxPages: baseline ? 2 : 5, mode: baseline ? "baseline" : "deep" })
          : await fetchSiteSignals(c.domain, c.name);
        let captureFailed = stateReadFailed;
        let storageFailed = stateReadFailed;
        const fetchedPending: string[] = [];
        const failedPending: string[] = [...(scan.coverage.failedUrls ?? [])];
        const urlOutcomes: SourceUrlOutcome[] = [...(scan.coverage.urlOutcomes ?? [])];
        const savedUrls: string[] = [...(scan.coverage.notModifiedUrls ?? [])];
        const pendingCache: Record<string, WebsiteCacheEntry> = {};
        if (captureEnabled) {
          // Reserve three slots for the prior backlog. Homepage discovery alone
          // must not keep selecting the same first few newsroom links forever.
          const pending = (priorPending.length ? priorPending : knownUrls)
            .filter(url => !scan.coverage.attemptedUrls.includes(url)).slice(0, baseline ? 0 : 3);
          await Promise.all(pending.map(async url => {
            try {
              const response = await fetchConditionalText(url, { timeoutMs: 3500, maxBytes: 1_000_000 }, priorCache[url]);
              if (response.status === 304 && priorCache[url]?.retained && sameCompanySite(response.finalUrl, base)) {
                savedUrls.push(priorCache[url].finalUrl); fetchedPending.push(url);
                urlOutcomes.push({ url, outcome: "success", status: 304 }); return;
              }
              const outcome = sameCompanySite(response.finalUrl, base) ? publicResponseOutcome(url, response.status, response.body)
                : { url, outcome: "unavailable" as const, code: "cross_company_redirect" as const };
              urlOutcomes.push(outcome);
              if ((response.status === 404 || response.status === 410) && sameCompanySite(response.finalUrl, base)) {
                fetchedPending.push(url); return; // confirmed absence is not an endless retry failure
              }
              if (outcome.outcome !== "success") { failedPending.push(url); return; }
              const page = sitePageEvidence(response.body, response.finalUrl);
              page.requestedUrls = [url];
              if (!page.text.trim()) throw new Error("Website page has no evidence");
              const existing = scan.pages.find(existing => existing.url === page.url);
              if (existing) existing.requestedUrls = [...new Set([...(existing.requestedUrls ?? [existing.url]), url])].sort();
              else scan.pages.push(page);
              pendingCache[url] = { finalUrl: page.url, validators: responseValidators(response), discoveredUrls: discoverSiteLinks(response.body, page.url).map(link => link.url).slice(0, 24), feedUrl: null, retained: false };
              fetchedPending.push(url);
            } catch (error) { failedPending.push(url); urlOutcomes.push({ url, outcome: "unavailable", code: sourceErrorCode(error) }); }
          }));
          if (!scan.pages.some(page => page.text.trim()) && !savedUrls.length) captureFailed = true;
          for (const page of scan.pages) {
            if (!page.text.trim()) continue;
            try {
              const published = [...new Set(page.sourceDates.filter(date => date.kind === "published").map(date => date.value))];
              const stored = await enqueueObservation({
                companyId: c.id, companyName: c.name, companyDomain: c.domain, companySubindustry: c.subindustry,
                sourceKind: "website", sourceUrl: page.url, title: page.title || `${c.name} company website`,
                text: page.text, eventDate: published.length === 1 ? published[0] : null,
                metadata: { sourceDates: page.sourceDates, meaningfulContentHash: page.contentHash, textTruncated: page.truncated,
                  ...(page.companyIdentity ? { companyIdentity: page.companyIdentity } : {}),
                  ...(page.identityClaims?.length ? { identityClaims: page.identityClaims } : {}),
                  eventDateBasis: published.length === 1 ? "page_publication" : "unknown", collectionMode: baseline ? "baseline" : "deep",
                  discovery: { collector: "website", url: page.url, requestedUrls: page.requestedUrls ?? [page.url], title: page.title, eventDate: published.length === 1 ? published[0] : null } },
              });
              if (!stored) { captureFailed = storageFailed = true; sweepError(stats, "website", "observation", "Website observation persistence disabled", c.id); }
              else savedUrls.push(page.url);
            } catch (error) { captureFailed = storageFailed = true; sweepError(stats, "website", "observation", error, c.id); }
          }
        }
        let touched = false;

        const current = [...new Set(scan.growth.map((h) => h.label))].sort();
        const fingerprint = !scan.pages.length && savedUrls.length ? c.site_hash ?? "" : current.join("|");
        const priorSet = new Set((c.site_hash ?? "").split("|").filter(Boolean));
        if (!captureEnabled) await setSiteChecked(c.id, fingerprint);
        stats.changed += scan.growth.filter((x) => !priorSet.has(x.label)).length;

        if (scan.parent && !opts.sourceOnly) {
          await setParent(c.id, scan.parent.name, scan.parent.confidence);
          stats.parents++;
          if (scan.parent.confidence === "high" && autodismiss) { await setCompaniesStatus([c.id], "dismissed"); stats.dismissed++; }
        }

        // Real newsroom/blog items retain the exact source page and the existing
        // event verifier, including the acquirer-position check for M&A.
        let feedCache = state?.cursor?.feedUrl === scan.feedUrl ? readNewsFeedCache(state?.cursor?.feedCache) : undefined;
        if (scan.feedUrl && !baseline) {
          const feedResult = await fetchFeedResult(scan.feedUrl, captureEnabled ? 12 : 8, { cache: feedCache });
          if (feedResult.cache) feedCache = feedResult.cache;
          if (feedResult.status === "unavailable") { captureFailed = true; sweepError(stats, "website", "feed", feedResult.error ?? "Website feed unavailable", c.id); }
          const feedItems = feedResult.items.filter(it => fresh(it.signal_date));
          if (captureEnabled) {
            for (let from = 0; from < feedItems.length; from += 4) {
              const results = await Promise.allSettled(feedItems.slice(from, from + 4).map(it => classifyAndRecordHeadline(c, it, { llm: !opts.sourceOnly, sourceOnly: opts.sourceOnly, requireNameMatch: false, classifierDeadlineMs })));
              for (const result of results) {
                if (result.status === "rejected") {
                  captureFailed = true;
                  const bodyUnavailable = opts.sourceOnly && result.reason instanceof Error && result.reason.message === "Source-only news article body unavailable";
                  if (!bodyUnavailable) storageFailed = true;
                  sweepError(stats, "website", bodyUnavailable ? "feed_body" : "headline", result.reason, c.id);
                }
                else if (result.value) { stats.triggered++; touched = true; }
              }
            }
          } else {
            for (const it of feedItems) {
              if (await classifyAndRecordHeadline(c, it, { llm: true, requireNameMatch: false, classifierDeadlineMs })) { stats.triggered++; touched = true; }
            }
          }
        }

        for (const hit of opts.sourceOnly ? [] : scan.financeRoles) {
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
          if (failedPending.length || warningCodes.length) sweepError(stats, "website", "pages", warningCodes.join(", ") || "Website pages unavailable", c.id);
          const httpCache = Object.fromEntries(Object.entries({ ...priorCache, ...scan.httpCache, ...pendingCache })
            .filter(([, entry]) => entry.retained || savedUrls.includes(entry.finalUrl))
            .map(([url, entry]) => [url, { ...entry, retained: true }]).slice(-24));
          const nameKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/(?:\s+(?:inc|llc|ltd|corp|corporation|incorporated))+$/, "");
          const publicAliases = [...new Set([
            ...(Array.isArray(state?.cursor?.publicAliases) ? state.cursor.publicAliases.filter((value): value is string => typeof value === "string") : []),
            ...scan.pages.flatMap(page => page.companyIdentity?.names.some(name => nameKey(name) === nameKey(c.name)) ? page.companyIdentity.names : []),
          ])].filter(name => name.length >= 3 && name.length <= 140).slice(0, 4);
          await writeSourceState(c.id, sourceKey, {
            cursor: { knownUrls: allKnown, verifiedUrls, pendingUrls: pending, attemptedPages: scan.coverage.attemptedUrls.length + fetchedPending.length + failedPending.length, retainedPages: scan.pages.length,
              baselineCapturedAt: state?.cursor?.baselineCapturedAt ?? (savedUrls.length ? new Date().toISOString() : null),
              collectionMode: baseline ? "baseline" : "deep", consecutiveFailures, urlOutcomes: urlOutcomes.slice(0, 16),
              httpCache, publicAliases, feedUrl: scan.feedUrl ?? state?.cursor?.feedUrl ?? null, feedCache,
              pageHashes: captureFailed ? state?.cursor?.pageHashes ?? {} : changes.hashes,
              changedSinceComplete: !complete && changedSinceComplete, revisit },
            complete,
            status: savedUrls.length ? (complete ? "complete" : "partial") : "unavailable", successful: savedUrls.length > 0,
            details: { urlOutcomes: urlOutcomes.slice(0, 16), savedPages: savedUrls.length, notModifiedPages: urlOutcomes.filter(outcome => outcome.status === 304).length, pendingPages: pending.length, storageError: captureFailed },
            nextAttemptAt: consecutiveFailures ? new Date(Date.now() + Math.min(24, 2 ** (consecutiveFailures - 1)) * 3600000).toISOString() : null,
            ...(incomplete ? { error: warningCodes.length ? `Website: ${warningCodes.join(", ")}` : captureFailed ? "Website evidence capture/storage incomplete" : "Website depth pending" } : {}),
          });
          if (!captureFailed) await setSiteChecked(c.id, fingerprint);
          outcome = storageFailed ? "failed" : savedUrls.length ? (complete ? "succeeded" : "partial") : "unavailable";
        } else {
          const available = scan.coverage.succeededUrls.length > 0 || Boolean(scan.coverage.notModifiedUrls?.length);
          outcome = available ? (captureFailed || failedPending.length || scan.coverage.remainingUrls.length ? "partial" : "succeeded") : "unavailable";
          if (failedPending.length || !available) sweepError(stats, "website", "pages", "Website evidence unavailable or incomplete", c.id);
        }
      } catch (error) { outcome = "failed"; sweepError(stats, "website", "collection", error, c.id); }
      finally {
        // A permanently broken domain must not monopolize the oldest-first cursor.
        try { await markSiteAttempted(c.id); }
        catch (error) { outcome = "failed"; sweepError(stats, "website", "attempt_stamp", error, c.id); }
        stats[outcome]++;
        accounting.record(c.id, outcome);
      }
    }));
  }
  return { ...stats, ...accounting.result() };
}
