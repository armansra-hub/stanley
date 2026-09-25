import type { ResearchProgress } from "@/lib/intelligence/researchProgress";
const count = (value: number) => value.toLocaleString();
export default function IntelligenceResearchProgress({ progress, stale = false }: { progress?: ResearchProgress; stale?: boolean }) {
  if (!progress?.available) return <p className="mb-4 text-xs text-[var(--text-muted)]">Research progress is currently unavailable.</p>;
  const { accounts, processing, lastHour } = progress;
  return <section aria-label="Research progress" className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <h2 className="western text-2xl">Research progress</h2>
    <p className="mt-2 text-xs text-[var(--text-muted)]" role={stale ? "status" : undefined}>{stale ? "Latest refresh unavailable. Showing saved figures from " : "Updated "}{new Date(progress.asOf).toLocaleString()}.</p>
    <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
      <div><p className="font-semibold">{count(accounts.withInterpretation)} / {count(accounts.total)} accounts with a Jev reading</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">{count(accounts.withEvidence)} have captured evidence. A first reading does not mean all sources are finished.</p></div>
      <div><p className="font-semibold">{count(accounts.caughtUp)} accounts caught up</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Known due sources have been read and interpreted. Discovery continues, and new information wakes research. Unknown facts can remain.</p></div>
      <div><p className="font-semibold">{count(processing.pending)} evidence items awaiting Jev</p>
        <p className="mt-1 text-xs text-[var(--text-muted)]">Last hour: {count(lastHour.newInterpretationJobs)} new items · {count(lastHour.completedInterpretationJobs)} completed. New arrivals prevent a reliable finish-time countdown.</p></div>
    </div>
    <p className="mt-3 text-xs text-[var(--text-muted)]">Account research: {count(accounts.researchReady)} ready · {count(accounts.researchRunning)} running · {count(accounts.sourceRetry)} waiting on source retries · {count(accounts.blockedInterpretation)} with blocked interpretations · {count(accounts.researchFailed)} failed · {count(accounts.discoveryCheckDue)} caught-up accounts due for discovery.</p>
  </section>;
}
