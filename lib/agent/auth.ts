import "server-only";
import { NextResponse } from "next/server";

/**
 * Shared-secret auth for /api/agent/*.
 *
 * The endpoint Codex built on 2026-07-15 had NO auth at all — a public URL that
 * rewrote every TAM score in the database. It is deleted now, but the replacement
 * must not repeat it: these routes accept bulk writes to the grading data Arman's
 * whole pipeline depends on.
 *
 * Accept only a dedicated agent credential in a header. Cron credentials and
 * query-string tokens are deliberately not bridge credentials: URLs are logged,
 * and cron secrets have a different operational scope.
 */
export function agentAuthOk(req: Request): boolean {
  const expected = [
    process.env.AGENT_TOKEN,
    process.env.CODEX_AGENT_TOKEN,
  ].filter(Boolean) as string[];
  if (!expected.length) return false; // never fail open

  const auth = req.headers.get("authorization");
  const presented = (auth?.startsWith("Bearer ") ? auth.slice(7) : null)
    ?? req.headers.get("x-agent-token");
  if (!presented) return false;

  return expected.some((e) => timingSafeEqual(e, presented));
}

/**
 * High-impact TAM coordination/publish routes accept only the dedicated agent
 * credential in a header. They deliberately reject CRON_SECRET, x-cron-secret,
 * and query-string tokens so a logged cron URL cannot become a grading key.
 */
export function tamMachineAuthOk(req: Request): boolean {
  return agentAuthOk(req);
}

/** Constant-time compare — a length-independent loop so a token can't be probed byte by byte. */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function unauthorized(): NextResponse {
  return NextResponse.json(
    { error: "unauthorized", hint: "send the shared secret as 'Authorization: Bearer <token>' or the 'x-agent-token' header" },
    { status: 401 },
  );
}

/** Which agent is calling. Defaults to codex — Claude works the repo directly and
 * names itself explicitly when it posts. */
export function callerAgent(req: Request, bodyAgent?: unknown): "codex" | "claude" {
  const claimed = String(bodyAgent ?? req.headers.get("x-agent-name") ?? "codex").toLowerCase();
  return claimed === "claude" ? "claude" : "codex";
}
