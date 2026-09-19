/** Public collection diagnostics contain transport categories, never response
 * bodies, request headers or credentials. Successful evidence remains usable
 * when another URL is unavailable. */
export type SourceErrorCode = "timeout" | "dns" | "tls" | "unsafe_target" | "network" | "http_error" | "blocked" | "empty_body" | "parse_error" | "cross_company_redirect" | "publisher_unresolved" | "storage_error";
export type SourceUrlOutcome = { url: string; outcome: "success" | "missing" | "unavailable"; code?: SourceErrorCode; status?: number };

export function sourceErrorCode(error: unknown): SourceErrorCode {
  const text = error instanceof Error ? `${error.name} ${error.message} ${(error as Error & { code?: string }).code ?? ""}` : "";
  if (/unsafe|private|redirect loop|redirect limit/i.test(text)) return "unsafe_target";
  if (/timed? ?out|timeout|abort/i.test(text)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|dns/i.test(text)) return "dns";
  if (/cert|TLS|SSL/i.test(text)) return "tls";
  return "network";
}

export function publicResponseOutcome(url: string, status: number, body: string): SourceUrlOutcome {
  if (status === 404 || status === 410) return { url, outcome: "missing", status };
  if (status === 401 || status === 403 || status === 429) return { url, outcome: "unavailable", code: "blocked", status };
  if (status < 200 || status >= 300) return { url, outcome: "unavailable", code: "http_error", status };
  if (!body.trim()) return { url, outcome: "unavailable", code: "empty_body", status };
  if (/<title[^>]*>\s*(?:just a moment|access denied|attention required|verify you are human)/i.test(body)
    || /cf-chl-|captcha-container|id=["']challenge-form["']/i.test(body)) return { url, outcome: "unavailable", code: "blocked", status };
  return { url, outcome: "success", status };
}
