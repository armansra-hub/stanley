type Health = {
  asOf: string;
  queue: { due: number; deferred: number; oldestDueAt: string | null; expiredLeases: number; completedLastHour: number; completedLast24h: number };
  freshness: { capturedLast24h: number; interpretedLast24h: number; medianCaptureToInterpretSeconds: number | null; p95CaptureToInterpretSeconds: number | null; lastCapturedAt: string | null; lastInterpretedAt: string | null };
  coverage: { tamAccounts: number; accountsWithEvidence: number; accountsInterpreted: number; websiteSuccess48h: number; atsSuccess48h: number };
  yield: { jevTriggersLast24h: number; distinctTriggeredAccountsLast24h: number; usefulFeedbackLast24h: number; medianCaptureToCardSeconds: number | null; modelCostLast24h: number };
};
export type IntelligenceHealthData = Health;
const count = (n: number) => n.toLocaleString();
function duration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) return "Not measured yet";
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} hr`;
}
export default function IntelligenceHealth({ health }: { health: Health }) {
  const { queue, freshness, coverage, yield: output } = health;
  const waiting = queue.oldestDueAt ? Math.max(0, (Date.parse(health.asOf) - Date.parse(queue.oldestDueAt)) / 1000) : null;
  return <section aria-label="Intelligence freshness and results" className="mb-6 rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    <h2 className="western text-2xl">Freshness and results</h2>
    <div className="mt-3 grid gap-5 text-sm sm:grid-cols-2 lg:grid-cols-4">
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Last 24 hours</p><p className="mt-1 text-xl font-semibold">{count(output.distinctTriggeredAccountsLast24h)} accounts triggered</p><p>{count(output.jevTriggersLast24h)} Jev findings · {count(output.usefulFeedbackLast24h)} marked useful</p><p className="mt-1 text-xs text-[var(--text-muted)]">Useful feedback reflects your explicit choices.</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Collection to interpretation</p><p className="mt-1 text-xl font-semibold">{duration(freshness.medianCaptureToInterpretSeconds)}</p><p>95th percentile: {duration(freshness.p95CaptureToInterpretSeconds)}</p><p className="mt-1 text-xs text-[var(--text-muted)]">Source to Triggered: {duration(output.medianCaptureToCardSeconds)} median</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Processing</p><p className="mt-1 text-xl font-semibold">{count(queue.completedLastHour)} jobs / last hour</p><p>{count(queue.due)} ready · {count(queue.deferred)} deferred</p><p className="mt-1 text-xs text-[var(--text-muted)]">{waiting === null ? "No ready backlog" : `Oldest ready item: ${duration(waiting)}`}{queue.expiredLeases > 0 ? ` · ${count(queue.expiredLeases)} interrupted jobs awaiting recovery` : ""}</p></div>
      <div><p className="text-xs uppercase text-[var(--text-muted)]">Current TAM coverage</p><p className="mt-1 text-xl font-semibold">{count(coverage.accountsInterpreted)} / {count(coverage.tamAccounts)}</p><p>Accounts with interpreted evidence</p><p className="mt-1 text-xs text-[var(--text-muted)]">Successful checks in 48 hr: {count(coverage.websiteSuccess48h)} websites · {count(coverage.atsSuccess48h)} job boards</p></div>
    </div>
    <p className="mt-4 border-t pt-3 text-xs text-[var(--text-muted)]">{count(freshness.capturedLast24h)} sources captured and {count(freshness.interpretedLast24h)} interpreted in 24 hr · ${output.modelCostLast24h.toFixed(3)} model spend/reservations. Timing begins when Stanley captures a source; publisher delays are outside this measurement.</p>
  </section>;
}
