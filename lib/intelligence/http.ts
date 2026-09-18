import "server-only";
import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";

export function intelligenceUiAuthorized(req: NextRequest): boolean {
  if (!process.env.APP_PASSWORD && !process.env.VERCEL) return true;
  const expected = process.env.APP_SESSION_TOKEN;
  const actual = req.cookies.get("jarvis_auth")?.value;
  if (!expected || !actual) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameOriginMutation(req: Request): boolean {
  const origin = req.headers.get("origin");
  // Browser same-origin writes include Origin; local/agent routes have their own authentication.
  return origin === new URL(req.url).origin;
}

export const isUuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);

export async function smallJson(req: Request, maxBytes = 12_000): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("content-length") ?? 0) > maxBytes) throw new Error("body_too_large");
  const text = await req.text();
  if (Buffer.byteLength(text) > maxBytes) throw new Error("body_too_large");
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("invalid_json");
  return parsed;
}
