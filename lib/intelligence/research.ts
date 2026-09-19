export type ResearchAttempt = { source_url: string; next_attempt_at: string; last_attempt_at: string | null };

/** Only caller-discovered same-company URLs enter this rotation. Successful reads
 * rest for seven days; failed reads back off, so unresolved gaps advance sources. */
export function researchCandidates(discovered: readonly string[], attempts: ResearchAttempt[], priority: (url: string) => number, now = Date.now()) {
  const previous = new Map(attempts.map(attempt => [attempt.source_url, attempt]));
  return [...new Set(discovered)].filter(url => !previous.has(url) || Date.parse(previous.get(url)!.next_attempt_at) <= now)
    .sort((a, b) => {
      const first = previous.get(a), second = previous.get(b);
      return Number(!!first?.last_attempt_at) - Number(!!second?.last_attempt_at)
        || priority(b) - priority(a)
        || Date.parse(first?.last_attempt_at ?? "1970-01-01") - Date.parse(second?.last_attempt_at ?? "1970-01-01")
        || a.localeCompare(b);
    }).slice(0, 100);
}
