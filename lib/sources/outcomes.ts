/** Public collection diagnostics contain transport categories, never response
 * bodies, request headers or credentials. Successful evidence remains usable
 * when another URL is unavailable. */
export type SourceErrorCode = "timeout" | "dns" | "tls" | "unsafe_target" | "network" | "http_error" | "blocked" | "empty_body" | "parse_error" | "cross_company_redirect" | "publisher_unresolved" | "storage_error";
export type SourceUrlOutcome = { url: string; outcome: "success" | "missing" | "unavailable"; code?: SourceErrorCode; status?: number };

const errorCategories = ["empty", "unusual_traffic", "human_verification", "service_unavailable", "rate_limited", "access_denied", "unrecognized", "encoded"] as const;
const errorReadStops = ["end", "byte_limit", "time_limit", "stream_error"] as const;
const errorEncodings = ["identity", "gzip", "x-gzip", "deflate", "br", "other"] as const;
const errorMediaTypes = ["text/html", "text/plain", "application/xml", "text/xml", "application/rss+xml", "application/json", "other"] as const;
export type HttpErrorDiagnostics = {
  schema: "google-news-http-error-v1";
  bodyPrefixSha256: string; bodyPrefixBytes: number; bodyComplete: boolean;
  readStop: typeof errorReadStops[number]; category: typeof errorCategories[number];
  encoding: typeof errorEncodings[number]; mediaType: typeof errorMediaTypes[number] | null;
  retryAfterSeconds: number | null; retryAfterDate: string | null;
};
export type HttpRequestContext = { attempts: 1 | 2; conditionalFirstRequest: boolean; unretained304Recovery: boolean };
export function httpRequestContext(value: unknown): HttpRequestContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (![1, 2].includes(v.attempts as number) || typeof v.conditionalFirstRequest !== "boolean" || v.unretained304Recovery !== (v.attempts === 2)) return undefined;
  return { attempts: v.attempts as 1 | 2, conditionalFirstRequest: v.conditionalFirstRequest, unretained304Recovery: v.unretained304Recovery };
}

export type HttpFailureSample = { ordinal: number; httpStatus: number | null; errorDiagnostics?: HttpErrorDiagnostics; requestContext?: HttpRequestContext };
export function httpFailureSamples(value: unknown): HttpFailureSample[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).flatMap((entry, index) => {
    if (!entry || typeof entry !== "object") return [];
    const v = entry as Record<string, unknown>, diagnostic = httpErrorDiagnostics(v.errorDiagnostics), context = httpRequestContext(v.requestContext);
    if (!diagnostic && !context) return [];
    return [{ ordinal: index + 1, httpStatus: typeof v.httpStatus === "number" && Number.isInteger(v.httpStatus) && v.httpStatus >= 100 && v.httpStatus <= 599 ? v.httpStatus : null,
      ...(diagnostic ? { errorDiagnostics: diagnostic } : {}), ...(context ? { requestContext: context } : {}) }];
  });
}

/** Re-project even retained metadata: no arbitrary provider fields or text escape. */
export function httpErrorDiagnostics(value: unknown): HttpErrorDiagnostics | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  if (v.schema !== "google-news-http-error-v1" || typeof v.bodyPrefixSha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.bodyPrefixSha256)
    || !Number.isSafeInteger(v.bodyPrefixBytes) || (v.bodyPrefixBytes as number) < 0 || (v.bodyPrefixBytes as number) > 8192
    || typeof v.bodyComplete !== "boolean" || !errorReadStops.includes(v.readStop as never)
    || v.bodyComplete !== (v.readStop === "end") || !errorCategories.includes(v.category as never) || !errorEncodings.includes(v.encoding as never)) return undefined;
  return { schema: "google-news-http-error-v1", bodyPrefixSha256: v.bodyPrefixSha256, bodyPrefixBytes: v.bodyPrefixBytes as number,
    bodyComplete: v.bodyComplete, readStop: v.readStop as HttpErrorDiagnostics["readStop"], category: v.category as HttpErrorDiagnostics["category"],
    encoding: v.encoding as HttpErrorDiagnostics["encoding"], mediaType: errorMediaTypes.includes(v.mediaType as never) ? v.mediaType as HttpErrorDiagnostics["mediaType"] : null,
    retryAfterSeconds: Number.isSafeInteger(v.retryAfterSeconds) && (v.retryAfterSeconds as number) >= 0 && (v.retryAfterSeconds as number) <= 604800 ? v.retryAfterSeconds as number : null,
    retryAfterDate: typeof v.retryAfterDate === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(v.retryAfterDate) && Number.isFinite(Date.parse(v.retryAfterDate)) ? v.retryAfterDate : null };
}

/** Categories describe a bounded untrusted body sample, not the cause of failure. */
export function httpErrorCategory(prefix: Uint8Array, encoding: HttpErrorDiagnostics["encoding"]): HttpErrorDiagnostics["category"] {
  if (!prefix.length) return "empty";
  if (encoding !== "identity") return "encoded";
  const text = Buffer.from(prefix).toString("utf8");
  if (/unusual traffic|automated queries/i.test(text)) return "unusual_traffic";
  if (/captcha|verify (?:that )?you are human|human verification/i.test(text)) return "human_verification";
  if (/service (?:temporarily )?unavailable|temporarily overloaded/i.test(text)) return "service_unavailable";
  if (/too many requests|rate limit/i.test(text)) return "rate_limited";
  if (/access denied|forbidden/i.test(text)) return "access_denied";
  return "unrecognized";
}

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
