import "server-only";
import { fetchPublicHttpText, validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import { htmlAttributes } from "./siteDiscovery";

const ENDPOINT = "https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je";
const cache = new Map<string, { url: string; expires: number }>();
export function googleArticleId(source: string): string | null {
  try {
    const url = validatePublicHttpUrl(source);
    return url.hostname === "news.google.com" ? /^\/(?:rss\/)?(?:articles|read)\/([A-Za-z0-9_-]{8,2048})\/?$/.exec(url.pathname)?.[1] ?? null : null;
  } catch { return null; }
}
const publisher = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  try { const url = validatePublicHttpUrl(raw); return /(?:^|\.)google\.com$/i.test(url.hostname) ? null : url.toString(); }
  catch { return null; }
};

/** Older links encode a protobuf length-delimited URL. No network needed. */
export function legacyGoogleArticleUrl(id: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,2048}$/.test(id)) return null;
  const bytes = Buffer.from(id, "base64url");
  if (bytes[0] !== 8 || bytes[1] !== 19 || bytes[2] !== 34) return null;
  let offset = 3, length = 0, shift = 0;
  while (offset < bytes.length && shift <= 21) {
    const byte = bytes[offset++]; length += (byte & 127) * 2 ** shift;
    if (!(byte & 128)) break;
    shift += 7;
  }
  if (!length || offset + length > bytes.length || length > 4096) return null;
  return publisher(bytes.subarray(offset, offset + length).toString("utf8"));
}

export function googleDecodingParameters(html: string) {
  for (const match of html.matchAll(/<[^>]+\bdata-n-a-sg\s*=[^>]*>/gi)) {
    const attrs = htmlAttributes(match[0]);
    if (/^[A-Za-z0-9_-]{8,512}$/.test(attrs["data-n-a-sg"] ?? "") && /^\d{9,13}$/.test(attrs["data-n-a-ts"] ?? "")) {
      return { signature: attrs["data-n-a-sg"], timestamp: Number(attrs["data-n-a-ts"]) };
    }
  }
  return null;
}

export function parseGoogleDecodedUrl(body: string): string | null {
  // Anti-XSSI and decimal length prefix lines are ignored. Only the expected
  // RPC response and its garturlres tuple can supply a publisher URL.
  for (const line of body.split("\n")) {
    if (!line.trim().startsWith("[")) continue;
    try {
      const envelopes: unknown = JSON.parse(line);
      if (!Array.isArray(envelopes)) continue;
      for (const envelope of envelopes) {
        if (!Array.isArray(envelope) || envelope[0] !== "wrb.fr" || envelope[1] !== "Fbv4je" || typeof envelope[2] !== "string") continue;
        const result: unknown = JSON.parse(envelope[2]);
        if (Array.isArray(result) && result[0] === "garturlres") return publisher(result[1]);
      }
    } catch { /* Malformed/public RPC changes remain unresolved, never guessed. */ }
  }
  return null;
}

async function postDecode(body: string, timeoutMs = 4000): Promise<string> {
  // Fixed public Google endpoint only; no credentials, cookies, redirects, or
  // browser state. Publisher bodies still use Stanley's DNS-pinned transport.
  const response = await fetch(ENDPOINT, { method: "POST", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs), headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8", referer: "https://news.google.com/" }, body });
  if (!response.ok || !response.body) throw new Error("Google link resolver unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1000000) throw new Error("Google resolver response too large");
      chunks.push(chunk.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString("utf8");
}

/** Public link-resolution protocol documented by googlenewsdecoder's authors:
 * https://github.com/SSujitX/google-news-url-decoder (decoderv4/new_decoderv1)
 * https://github.com/dbernheisel/google_news_decoder/blob/main/lib/google_news_decoder.ex
 * Independently implemented with bounded transport; no consent/CAPTCHA bypass.
 */
export async function resolveGoogleArticle(source: string, html: string, deps: { post?: (body: string) => Promise<string>; now?: () => number; deadlineMs?: number } = {}) {
  const id = googleArticleId(source); if (!id) return null;
  const now = deps.now?.() ?? Date.now();
  const cached = cache.get(id);
  if (cached && cached.expires > now) return { url: cached.url, method: "cache" };
  const legacy = legacyGoogleArticleUrl(id);
  if (legacy) return { url: legacy, method: "base64_protobuf" };
  let params = googleDecodingParameters(html);
  const remaining = () => Math.min(4000, (deps.deadlineMs ?? Date.now() + 4000) - Date.now());
  try {
    if (!params) {
      if (remaining() < 250) return null;
      const page = await fetchPublicHttpText(`https://news.google.com/articles/${id}`, { timeoutMs: remaining(), maxBytes: 1000000, maxRedirects: 2 });
      if (page.status === 200 && new URL(page.finalUrl).hostname === "news.google.com") params = googleDecodingParameters(page.body);
    }
    if (!params) return null;
    if (remaining() < 250) return null;
    const context = [["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0];
    const request = JSON.stringify([[ ["Fbv4je", JSON.stringify(["garturlreq", context, id, params.timestamp, params.signature])] ]]);
    const body = new URLSearchParams({ "f.req": request }).toString();
    const url = parseGoogleDecodedUrl(await (deps.post ? deps.post(body) : postDecode(body, remaining())));
    if (!url) return null;
    if (cache.size >= 512) cache.delete(cache.keys().next().value!);
    cache.set(id, { url, expires: now + 7 * 86400000 });
    return { url, method: "public_google_rpc" };
  } catch { return null; }
}
