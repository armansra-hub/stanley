type Work = { queued: number; running: number; failed: number };
export type IntelligenceHealthData = {
  asOf: string; scope?: "eligible_tam"; spendScope?: "global";
  queue: { due: number; deferred: number; running?: number; failed?: number; oldestDueAt: string | null; expiredLeases: number; completedLastHour: number; completedLast24h: number };
  work?: { stories: Work; research: Work };
  freshness: { capturedLast24h: number; interpretedLast24h: number; medianCaptureToInterpretSeconds: number | null; p95CaptureToInterpretSeconds: number | null; lastCapturedAt: string | null; lastInterpretedAt: string | null;
    latestCohort?: { start: string | null; end: string | null; captured: number; interpreted: number; pending: number; medianSeconds: number | null; p95Seconds: number | null } };
  coverage: { tamAccounts: number; accountsWithEvidence: number; accountsFirstCapturedLastHour?: number; accountsFirstCapturedLast24h?: number; sourceChangedLastHour?: number; accountsInterpreted: number; accountsWithTopics?: number; accountsWithStoredStory?: number; accountsWithHiringBaseline?: number; websiteSuccess48h: number; atsSuccess48h: number };
  yield: { allTriggersLast24h?: number; allTriggeredAccountsLast24h?: number; jevTriggersLast24h: number; distinctTriggeredAccountsLast24h: number; usefulFeedbackLast24h: number; medianCaptureToCardSeconds: number | null; modelCostLast24h: number };
};
const count = (n: number) => n.toLocaleString();
function duration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "Not measured yet";
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}
export default function IntelligenceHealth({ health }: { health: IntelligenceHealthData }) {
  const { queue, freshness, coverage, yield: output } = health;
  const cohort = freshness.latestCohort;
  const waiting = queue.oldestDueAt ? Math.max(0, (Date.parse(health.asOf) - Date.parse(queue.oldestDueAt)) / 1000) : null;
  return <section aria-label="Intelligence freshness and results" className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <h2 className="western text-2xl">Freshness and results</h2>
    <p className="mt-1 text-xs text-[var(--text-muted)]">Counts cover current eligible TAM accounts. One account can have many sources and processing jobs.</p>
    <div className="mt-3 grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Cards detected in 24 hours</p>
        {output.allTriggeredAccountsLast24h !== undefined && <><p className="mt-1 text-xl font-semibold">{count(output.allTriggeredAccountsLast24h)} accounts with trigger cards</p><p>{count(output.allTriggersLast24h ?? 0)} cards across all sources</p></>}
        <p className="mt-2">{count(output.jevTriggersLast24h)} cards with Jev output across {count(output.distinctTriggeredAccountsLast24h)} accounts</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{count(output.usefulFeedbackLast24h)} evidence items marked useful. Jev interpretations can remain account context without creating a timely trigger card.</p>
      </div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">{cohort ? "Newest capture cohort" : "Interpretations completed in 24 hr"}</p>
        <p className="mt-1 text-xl font-semibold">{duration(cohort ? cohort.medianSeconds : freshness.medianCaptureToInterpretSeconds)}</p>
        <p>Median capture to interpretation</p>
        {cohort && <p className="mt-1">{count(cohort.interpreted)} of {count(cohort.captured)} sources interpreted · {count(cohort.pending)} pending</p>}
        <p className="mt-1 text-xs text-[var(--text-muted)]">{cohort?.start ? `Captured in the hour starting ${new Date(cohort.start).toLocaleString()}. ` : ""}Timing measures finished sources only, not an estimate for pending work.</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">24 hr completed median: {duration(freshness.medianCaptureToInterpretSeconds)} · 95th percentile: {duration(freshness.p95CaptureToInterpretSeconds)}</p>
      </div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Evidence processing jobs</p><p className="mt-1 text-xl font-semibold">{count(queue.completedLastHour)} completed / last hour</p><p>{count(queue.due)} ready · {count(queue.deferred)} deferred{queue.running !== undefined ? ` · ${count(queue.running)} running` : ""}</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{waiting === null ? "No ready backlog" : `Oldest ready item: ${duration(waiting)}`}{queue.expiredLeases > 0 ? ` · ${count(queue.expiredLeases)} interrupted jobs awaiting recovery` : ""}{queue.failed ? ` · ${count(queue.failed)} failed` : ""}</p>
        {health.work && <div className="mt-2 text-xs text-[var(--text-muted)]">{([['Account stories', health.work.stories], ['Directed research', health.work.research]] as const).map(([label, work]) => <p key={label}>{label}: {count(work.queued)} queued · {count(work.running)} running · {count(work.failed)} failed</p>)}</div>}
      </div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Current TAM account coverage</p><p className="mt-1 text-xl font-semibold">{count(coverage.accountsInterpreted)} / {count(coverage.tamAccounts)}</p><p>Accounts with at least one interpreted source</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{count(coverage.accountsWithEvidence)} have captured evidence{coverage.accountsWithTopics !== undefined ? ` · ${count(coverage.accountsWithTopics)} have supported traits` : ""}{coverage.accountsWithStoredStory !== undefined ? ` · ${count(coverage.accountsWithStoredStory)} have a stored story` : ""}{coverage.accountsWithHiringBaseline !== undefined ? ` · ${count(coverage.accountsWithHiringBaseline)} have a completed hiring scan` : ""}. Research depth varies by account.</p>
        {coverage.accountsFirstCapturedLastHour !== undefined && <p className="mt-1 text-xs text-[var(--text-muted)]">First evidence captured for {count(coverage.accountsFirstCapturedLastHour)} accounts in the last hour / {count(coverage.accountsFirstCapturedLast24h ?? 0)} in 24 hr. {count(coverage.sourceChangedLastHour ?? 0)} previously seen account sources changed in the last hour.</p>}
        <p className="mt-1 text-xs text-[var(--text-muted)]">Successful checks in 48 hr: {count(coverage.websiteSuccess48h)} accounts’ websites · {count(coverage.atsSuccess48h)} accounts with completed job-board scans. A successful check can find no new evidence.</p>
      </div>
    </div>
    <p className="mt-4 border-t pt-3 text-xs text-[var(--text-muted)]">{count(freshness.capturedLast24h)} current sources captured and {count(freshness.interpretedLast24h)} interpreted in 24 hr · ${output.modelCostLast24h.toFixed(3)} global model spend/reservations. Timing starts at capture; publisher delays are outside this measurement.</p>
  </section>;
}
