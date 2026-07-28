import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, unauthorized } from "@/lib/agent/auth";
import { mintTicket } from "@/lib/agent/tickets";
import { logEvent } from "@/lib/db/events";

/**
 * Mint a scoped, expiring upload ticket for an agent that cannot hold AGENT_TOKEN.
 *
 * Minting requires the token; using the resulting ticket does not. So Claude mints
 * one bound to the exact Internal IDs of a released package and hands over just the
 * ticket URL. The holder can upload record text for those leads until it expires,
 * and can do nothing else — no reads, no grade writes, no other leads.
 *
 * POST { scopeIds: ["123", ...], hours?: 24, maxUses?: 50, note?: "package 1" }
 * GET  — list live tickets (never returns secrets)
 */
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();

  let body: { scopeIds?: unknown; hours?: unknown; maxUses?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.scopeIds) || !body.scopeIds.length) {
    return NextResponse.json({ error: "scopeIds must be a non-empty array of NetSuite internal IDs" }, { status: 400 });
  }
  if (body.scopeIds.length > 5000) {
    return NextResponse.json({ error: "scopeIds capped at 5000 per ticket" }, { status: 400 });
  }

  try {
    const t = await mintTicket({
      scopeIds: body.scopeIds.map(String),
      hours: body.hours === undefined ? undefined : Number(body.hours),
      maxUses: body.maxUses === undefined ? undefined : Number(body.maxUses),
      note: body.note === undefined ? undefined : String(body.note).slice(0, 200),
    });
    await logEvent("headhunter", "agent.ticket_minted", {
      summary: `Upload ticket ${t.id} minted for ${t.scopeCount} leads, expires ${t.expiresAt}`,
      entity_type: "agent_bridge",
      meta: { ticketId: t.id, scopeCount: t.scopeCount, maxUses: t.maxUses, expiresAt: t.expiresAt, note: body.note ?? null },
    });
    const base = process.env.APP_BASE_URL ?? "https://jarvis-sable-eta.vercel.app";
    return NextResponse.json({
      ticket: t.ticket,
      uploadUrl: `${base}/api/agent/documents?ticket=${encodeURIComponent(t.ticket)}`,
      expiresAt: t.expiresAt,
      scopeCount: t.scopeCount,
      maxUses: t.maxUses,
      usage: "POST the same { docs: [...] } body to uploadUrl. No other auth needed. Every doc's internalId must be inside the ticket scope; sha256 verification and idempotency are unchanged.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "mint failed" }, { status: 400 });
  }
}

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const { data, error } = await serviceClient()
    .from("upload_tickets")
    .select("id, scope_ids, max_uses, uses, expires_at, created_by, note, created_at, last_used_at, revoked_at")
    .order("created_at", { ascending: false })
    .limit(25);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const now = Date.now();
  return NextResponse.json({
    tickets: (data ?? []).map((t) => ({
      id: t.id,
      scopeCount: (t.scope_ids as string[])?.length ?? 0,
      uses: t.uses, maxUses: t.max_uses,
      expiresAt: t.expires_at, note: t.note, createdBy: t.created_by, lastUsedAt: t.last_used_at,
      live: !t.revoked_at && new Date(String(t.expires_at)).getTime() > now && Number(t.uses) < Number(t.max_uses),
    })),
  });
}
