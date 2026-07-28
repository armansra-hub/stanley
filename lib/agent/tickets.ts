import "server-only";
import { createHash, randomBytes } from "crypto";
import { serviceClient } from "@/lib/supabase/server";

/**
 * Scoped, expiring upload tickets.
 *
 * Codex's cloud session cannot read AGENT_TOKEN, so it cannot authenticate to
 * /api/agent/documents. The answer is not to widen the long-lived secret: Claude
 * mints a ticket bound to the exact Internal IDs of a released package, with an
 * expiry and a use cap, and shares only that. Worst case for a leaked ticket is
 * that someone can upload record text for those specific leads until it expires.
 * It grants no read access and cannot write a grade.
 *
 * The secret is returned once at mint time and never stored — only its hash.
 */

export interface MintedTicket {
  ticket: string;       // "<id>.<secret>" — give this to the uploader
  id: string;
  expiresAt: string;
  scopeCount: number;
  maxUses: number;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function mintTicket(opts: {
  scopeIds: string[];
  hours?: number;
  maxUses?: number;
  note?: string;
  createdBy?: string;
}): Promise<MintedTicket> {
  const scopeIds = [...new Set(opts.scopeIds.map((s) => String(s).trim()).filter((s) => /^\d+$/.test(s)))];
  if (!scopeIds.length) throw new Error("scopeIds must contain at least one numeric internal ID");

  const secret = randomBytes(32).toString("base64url");
  const hours = Math.min(Math.max(opts.hours ?? 24, 1), 168); // 1h..7d
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();

  const { data, error } = await serviceClient().from("upload_tickets").insert({
    secret_sha256: sha256(secret),
    scope_ids: scopeIds,
    max_uses: Math.min(Math.max(opts.maxUses ?? 50, 1), 500),
    expires_at: expiresAt,
    created_by: opts.createdBy ?? "claude",
    note: opts.note ?? null,
  }).select("id, max_uses").single();
  if (error) throw new Error(error.message);

  return {
    ticket: `${data.id}.${secret}`,
    id: String(data.id),
    expiresAt,
    scopeCount: scopeIds.length,
    maxUses: Number(data.max_uses),
  };
}

export interface TicketCheck {
  ok: boolean;
  reason?: string;
  id?: string;
  scopeIds?: Set<string>;
  remaining?: number;
}

/** Validate a "<id>.<secret>" ticket. Does NOT consume a use — call consumeTicket after a successful upload. */
export async function verifyTicket(raw: string | null): Promise<TicketCheck> {
  if (!raw || !raw.includes(".")) return { ok: false, reason: "malformed ticket" };
  const idx = raw.indexOf(".");
  const id = raw.slice(0, idx);
  const secret = raw.slice(idx + 1);
  if (!/^[0-9a-f-]{36}$/i.test(id) || secret.length < 20) return { ok: false, reason: "malformed ticket" };

  const { data } = await serviceClient().from("upload_tickets").select("*").eq("id", id).maybeSingle();
  if (!data) return { ok: false, reason: "unknown ticket" };
  if (data.revoked_at) return { ok: false, reason: "ticket revoked" };
  if (new Date(String(data.expires_at)).getTime() < Date.now()) return { ok: false, reason: "ticket expired" };
  if (Number(data.uses) >= Number(data.max_uses)) return { ok: false, reason: "ticket use limit reached" };
  if (sha256(secret) !== data.secret_sha256) return { ok: false, reason: "bad ticket secret" };

  return {
    ok: true,
    id,
    scopeIds: new Set((data.scope_ids as string[]).map(String)),
    remaining: Number(data.max_uses) - Number(data.uses),
  };
}

export async function consumeTicket(id: string): Promise<void> {
  const db = serviceClient();
  const { data } = await db.from("upload_tickets").select("uses").eq("id", id).maybeSingle();
  await db.from("upload_tickets")
    .update({ uses: Number(data?.uses ?? 0) + 1, last_used_at: new Date().toISOString() })
    .eq("id", id);
}
