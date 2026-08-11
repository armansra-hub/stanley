import "server-only";

import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

export interface ResolvedPublicAddress {
  address: string;
  family: 4 | 6;
}

export type PublicHostResolver = (hostname: string) => Promise<ResolvedPublicAddress[]>;

export class UnsafeHttpTargetError extends Error {
  constructor(message = "unsafe HTTP target") {
    super(message);
    this.name = "UnsafeHttpTargetError";
  }
}

function normalizedHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase();
  const unbracketed = lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
  return unbracketed.endsWith(".") ? unbracketed.slice(0, -1) : unbracketed;
}

function ipv4Parts(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

function ipv6Value(address: string): bigint | null {
  let input = address.toLowerCase();
  if (input.includes("%")) return null; // scoped/zone addresses are never public web targets
  if (input.includes(".")) {
    const split = input.lastIndexOf(":");
    const v4 = ipv4Parts(input.slice(split + 1));
    if (split < 0 || !v4) return null;
    input = `${input.slice(0, split)}:${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InPrefix(value: bigint, base: bigint, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return (value >> shift) === (base >> shift);
}

const IPV6_DOCUMENTATION = ipv6Value("2001:db8::")!;
const IPV6_DOCUMENTATION_2 = ipv6Value("3fff::")!;
const IPV6_SPECIAL_2001 = ipv6Value("2001::")!;
const IPV6_6TO4 = ipv6Value("2002::")!;

/** True only for ordinary globally routable unicast addresses. */
export function isPublicIpAddress(rawAddress: string): boolean {
  const address = normalizedHostname(rawAddress);
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 0 && c === 0) return false;
    if (a === 192 && b === 0 && c === 2) return false; // documentation
    if (a === 192 && b === 88 && c === 99) return false; // deprecated 6to4 relay
    if (a === 192 && b === 168) return false;
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // documentation
    if (a === 203 && b === 0 && c === 113) return false; // documentation
    if (a >= 224) return false; // multicast, reserved, broadcast
    return true;
  }

  const v6 = ipv6Value(address);
  if (v6 == null) return false;
  // Ordinary public IPv6 unicast is 2000::/3. This excludes loopback, unspecified,
  // mapped IPv4, NAT64, discard-only, ULA, link/site-local and multicast space.
  if ((v6 >> 125n) !== 1n) return false;
  if (ipv6InPrefix(v6, IPV6_SPECIAL_2001, 23)) return false;
  if (ipv6InPrefix(v6, IPV6_DOCUMENTATION, 32)) return false;
  if (ipv6InPrefix(v6, IPV6_DOCUMENTATION_2, 20)) return false;
  if (ipv6InPrefix(v6, IPV6_6TO4, 16)) return false;
  return true;
}

const RESERVED_HOST_SUFFIXES = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "lan",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
] as const;

export function isPublicHostname(rawHostname: string): boolean {
  const hostname = normalizedHostname(rawHostname);
  const literalFamily = isIP(hostname);
  if (literalFamily) return isPublicIpAddress(hostname);
  if (!hostname || hostname.length > 253 || !hostname.includes(".")) return false;
  const labels = hostname.split(".");
  if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return false;
  return !RESERVED_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`));
}

/** Syntax/host gate performed before DNS and again for every redirect target. */
export function validatePublicHttpUrl(rawUrl: string | URL): URL {
  const text = String(rawUrl);
  if (!text || text.length > 4_096) throw new UnsafeHttpTargetError();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeHttpTargetError();
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new UnsafeHttpTargetError();
  if (url.port && !((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443"))) {
    throw new UnsafeHttpTargetError();
  }
  if (!isPublicHostname(url.hostname)) throw new UnsafeHttpTargetError();
  return url;
}

const defaultResolver: PublicHostResolver = async (hostname) => {
  const answers = await lookup(hostname, { all: true, verbatim: true });
  return answers
    .filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6)
    .map(({ address, family }) => ({ address, family }));
};

/** Reject mixed public/private DNS answers; pinning later uses one member of this set. */
export async function resolvePublicAddresses(
  rawHostname: string,
  resolver: PublicHostResolver = defaultResolver,
): Promise<ResolvedPublicAddress[]> {
  const hostname = normalizedHostname(rawHostname);
  if (!isPublicHostname(hostname)) throw new UnsafeHttpTargetError();
  const literalFamily = isIP(hostname);
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await resolver(hostname);
  if (answers.length === 0 || answers.some((answer) => !isPublicIpAddress(answer.address))) {
    throw new UnsafeHttpTargetError();
  }
  const unique = [...new Map(answers.map((answer) => [`${answer.family}:${answer.address}`, answer])).values()];
  return unique.sort((a, b) => a.family - b.family); // prefer IPv4 when both are safe
}

export function resolveSafeHttpRedirect(current: URL, location: string): URL {
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new UnsafeHttpTargetError();
  }
  return validatePublicHttpUrl(target);
}

function deadlinePromise<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return Promise.reject(new Error("HTTP verification timed out"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("HTTP verification timed out")), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function requestPinned(
  url: URL,
  address: ResolvedPublicAddress,
  timeoutMs: number,
): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: { status: number; location: string | null } | null,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(result!);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      agent: false,
      maxHeaderSize: 16_384,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; StanleyTAMBot/1.0; +https://jarvis-sable-eta.vercel.app)",
        accept: "text/html,application/xhtml+xml",
      },
      // Never perform a second DNS lookup between validation and connect. HTTPS
      // still verifies the certificate and SNI against the original URL hostname.
      lookup: ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as never,
    }, (response) => {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] ?? null : locationHeader ?? null;
      const status = response.statusCode ?? 0;
      response.destroy();
      finish({ status, location });
    });
    // This is a wall-clock bound, not Node's idle-socket timeout: a peer cannot
    // extend verification indefinitely by trickling header bytes.
    const deadlineTimer = setTimeout(
      () => request.destroy(new Error("HTTP verification timed out")),
      timeoutMs,
    );
    request.once("error", (error) => finish(null, error));
    request.end();
  });
}

function requestPinnedText(
  url: URL,
  address: ResolvedPublicAddress,
  timeoutMs: number,
  maxBytes: number,
  accept: string,
): Promise<{ status: number; location: string | null; body: string; contentType: string | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (
      result: { status: number; location: string | null; body: string; contentType: string | null } | null,
      error?: Error,
    ) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (error) reject(error);
      else resolve(result!);
    };
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "GET",
      agent: false,
      maxHeaderSize: 16_384,
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; StanleyTAMBot/1.0; +https://jarvis-sable-eta.vercel.app)",
        accept,
      },
      // Connect only to the address set that passed the all-answers-public gate.
      // TLS certificate validation and SNI still use the original hostname.
      lookup: ((_: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      }) as never,
    }, (response) => {
      const locationHeader = response.headers.location;
      const location = Array.isArray(locationHeader) ? locationHeader[0] ?? null : locationHeader ?? null;
      const contentTypeHeader = response.headers["content-type"];
      const contentType = Array.isArray(contentTypeHeader) ? contentTypeHeader[0] ?? null : contentTypeHeader ?? null;
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) || status < 200 || status >= 300) {
        response.destroy();
        finish({ status, location, body: "", contentType });
        return;
      }

      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          response.destroy(new Error("HTTP response exceeded size limit"));
          return;
        }
        chunks.push(buffer);
      });
      response.once("end", () => finish({
        status,
        location,
        body: Buffer.concat(chunks).toString("utf8"),
        contentType,
      }));
      response.once("error", (error) => finish(null, error));
    });
    // Absolute wall-clock bound includes connection, headers, and body. A peer
    // cannot extend it indefinitely by trickling bytes.
    deadlineTimer = setTimeout(
      () => request.destroy(new Error("HTTP fetch timed out")),
      timeoutMs,
    );
    request.once("error", (error) => finish(null, error));
    request.end();
  });
}

export interface PublicHttpStatus {
  status: number;
  finalUrl: string;
}

export interface PublicHttpTextResponse extends PublicHttpStatus {
  body: string;
  contentType: string | null;
}

export interface PublicHttpFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  accept?: string;
  resolver?: PublicHostResolver;
}

/**
 * Bounded body fetch for public sources. Every hop is syntax-checked, resolved
 * with an all-answers-public policy, and connected through a pinned address.
 * Redirects are followed manually under the same absolute deadline.
 */
export async function fetchPublicHttpText(
  rawUrl: string,
  opts: PublicHttpFetchOptions = {},
): Promise<PublicHttpTextResponse> {
  const timeoutMs = Math.max(250, Math.min(opts.timeoutMs ?? 7_000, 15_000));
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? 4, 6));
  const maxBytes = Math.max(16_384, Math.min(opts.maxBytes ?? 4_000_000, 5_000_000));
  const accept = (opts.accept ?? "text/html,application/xhtml+xml,application/xml,text/xml,application/json,text/plain;q=0.8")
    .replace(/[\r\n]/g, "")
    .slice(0, 512);
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  let current = validatePublicHttpUrl(rawUrl);

  for (let redirects = 0; ; redirects++) {
    const key = current.toString();
    if (seen.has(key)) throw new UnsafeHttpTargetError("redirect loop");
    seen.add(key);

    const addresses = await deadlinePromise(
      resolvePublicAddresses(current.hostname, opts.resolver),
      deadline - Date.now(),
    );
    const remainingForRequest = deadline - Date.now();
    if (remainingForRequest <= 0) throw new Error("HTTP fetch timed out");
    const response = await requestPinnedText(current, addresses[0], remainingForRequest, maxBytes, accept);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) {
      return { ...response, finalUrl: current.toString() };
    }
    if (redirects >= maxRedirects) throw new UnsafeHttpTargetError("redirect limit exceeded");
    current = resolveSafeHttpRedirect(current, response.location);
  }
}

/**
 * Bounded GET that validates and DNS-pins every redirect hop. It reads headers
 * only and never delegates redirects to a client that could re-resolve the host.
 */
export async function fetchPublicHttpStatus(
  rawUrl: string,
  opts: { timeoutMs?: number; maxRedirects?: number; resolver?: PublicHostResolver } = {},
): Promise<PublicHttpStatus> {
  const timeoutMs = Math.max(250, Math.min(opts.timeoutMs ?? 4_500, 10_000));
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? 4, 6));
  const deadline = Date.now() + timeoutMs;
  const seen = new Set<string>();
  let current = validatePublicHttpUrl(rawUrl);

  for (let redirects = 0; ; redirects++) {
    const key = current.toString();
    if (seen.has(key)) throw new UnsafeHttpTargetError("redirect loop");
    seen.add(key);

    const remainingForDns = deadline - Date.now();
    const addresses = await deadlinePromise(
      resolvePublicAddresses(current.hostname, opts.resolver),
      remainingForDns,
    );
    const remainingForRequest = deadline - Date.now();
    if (remainingForRequest <= 0) throw new Error("HTTP verification timed out");
    const response = await requestPinned(current, addresses[0], remainingForRequest);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) {
      return { status: response.status, finalUrl: current.toString() };
    }
    if (redirects >= maxRedirects) throw new UnsafeHttpTargetError("redirect limit exceeded");
    current = resolveSafeHttpRedirect(current, response.location);
  }
}
