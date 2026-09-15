import "server-only";

export class PublicGrowthDeadlineError extends Error {
  constructor() { super("public-growth request deadline reached"); this.name = "PublicGrowthDeadlineError"; }
}

export function requirePublicGrowthTime(deadlineMs?: number): void {
  if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || Date.now() >= deadlineMs)) throw new PublicGrowthDeadlineError();
}

async function retryDelay(delayMs: number, deadlineMs?: number) {
  requirePublicGrowthTime(deadlineMs);
  if (deadlineMs !== undefined && Date.now() + delayMs >= deadlineMs) throw new PublicGrowthDeadlineError();
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000, attempts = 3, deadlineMs?: number): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    requirePublicGrowthTime(deadlineMs);
    const ctl = new AbortController();
    const effectiveTimeout = deadlineMs === undefined ? timeoutMs : Math.min(timeoutMs, Math.max(1, deadlineMs - Date.now()));
    const timer = setTimeout(() => ctl.abort(), effectiveTimeout);
    try {
      const response = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: "application/json", ...(init.headers ?? {}) } });
      if (!response.ok) {
        const text = await response.text();
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(30_000, retryAfter * 1_000)
            : 750 * 2 ** attempt;
          await retryDelay(delayMs, deadlineMs);
          continue;
        }
        throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }
      return await response.json() as T;
    } catch (error) {
      requirePublicGrowthTime(deadlineMs);
      if (error instanceof PublicGrowthDeadlineError) throw error;
      last = error;
      if (attempt + 1 >= attempts) throw error;
      // Network resets and transient egress failures do not carry an HTTP
      // status. Retrying immediately only amplifies them during a foundation
      // sweep, so give the upstream a progressively larger recovery window.
      await retryDelay(750 * 2 ** attempt, deadlineMs);
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
