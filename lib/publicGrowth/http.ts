import "server-only";

export async function fetchJson<T>(url: string, init: RequestInit = {}, timeoutMs = 15_000, attempts = 3): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: ctl.signal, headers: { accept: "application/json", ...(init.headers ?? {}) } });
      if (!response.ok) {
        const text = await response.text();
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(30_000, retryAfter * 1_000)
            : 750 * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`);
      }
      return await response.json() as T;
    } catch (error) {
      last = error;
      if (attempt + 1 >= attempts) throw error;
      // Network resets and transient egress failures do not carry an HTTP
      // status. Retrying immediately only amplifies them during a foundation
      // sweep, so give the upstream a progressively larger recovery window.
      await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
