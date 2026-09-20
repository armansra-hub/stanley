import { fetchPublicHttpText, type PublicHttpFetchOptions, type PublicHttpTextResponse } from "@/lib/triggers/urlSafety";

export type HttpValidators = { etag?: string; lastModified?: string; url: string };
export function retainedValidators(value: unknown, url: string): HttpValidators | undefined {
  if (!value || typeof value !== "object") return undefined;
  const entry = value as Record<string, unknown>;
  try { if (typeof entry.url !== "string" || new URL(entry.url).toString() !== new URL(url).toString()) return undefined; } catch { return undefined; }
  const etag = typeof entry.etag === "string" && entry.etag.length <= 1000 && !/[\r\n]/.test(entry.etag) ? entry.etag : undefined;
  const lastModified = typeof entry.lastModified === "string" && entry.lastModified.length <= 100 && !/[\r\n]/.test(entry.lastModified) ? entry.lastModified : undefined;
  return etag || lastModified ? { url, ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) } : undefined;
}
export function responseValidators(response: PublicHttpTextResponse): HttpValidators | undefined {
  return retainedValidators({ url: response.finalUrl, etag: response.etag, lastModified: response.lastModified }, response.finalUrl);
}
/** A 304 is usable only when the caller has retained the exact representation.
 * Missing cache / unsolicited 304 gets one bounded unconditional recovery. */
export async function fetchConditionalText(url: string, options: PublicHttpFetchOptions, cache?: { validators?: HttpValidators; retained: boolean }, fetchText = fetchPublicHttpText) {
  const validators = cache?.retained ? retainedValidators(cache.validators, url) : undefined;
  const started = Date.now();
  const response = await fetchText(url, { ...options,
    ...(validators?.etag ? { ifNoneMatch: validators.etag } : {}),
    ...(validators?.lastModified ? { ifModifiedSince: validators.lastModified } : {}),
  });
  if (response.status !== 304 || (validators && cache?.retained && new URL(response.finalUrl).toString() === new URL(url).toString())) return response;
  const remaining = (options.timeoutMs ?? 7000) - (Date.now() - started);
  if (remaining < 250) throw new Error("HTTP fetch timed out");
  const recovered = await fetchText(url, { ...options, timeoutMs: remaining });
  if (recovered.status === 304) throw new Error("Unsolicited 304 without retained representation");
  return recovered;
}
