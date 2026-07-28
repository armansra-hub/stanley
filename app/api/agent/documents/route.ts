import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { serviceClient } from "@/lib/supabase/server";
import { logEvent } from "@/lib/db/events";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";
import { consumeTicket, verifyTicket } from "@/lib/agent/tickets";
import { coerceDate, coerceText, pick } from "@/lib/agent/coerce";

/**
 * Lead record TEXT, pushed by whichever agent can see the record and readable by
 * the other. This is how the TAM's source material crosses between machines.
 *
 * TEXT, NOT PDFs, on purpose. The PDF corpus is ~15GB; this project runs on
 * Supabase's free tier (500MB database, no storage buckets provisioned). The full
 * extracted text of all ~7,400 leads is ~100MB and fits comfortably — and text is
 * what a grader actually reads. Extract on the machine that holds the PDFs, push
 * the text. (Arman's 7/14 run extracted 7,130 leads — 109k pages — in 33 minutes.)
 *
 * POST { docs: [{ internalId, body, docType?, source?, title?, capturedAt? }] }
 * GET  ?internalId=123 | ?missing=1 (which TAM leads still have no text)
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_DOCS = 200;
const MAX_CHARS = 400_000; // ~100k tokens — larger than any real NetSuite record

/**
 * Three ways in, because Codex's cloud session cannot hold AGENT_TOKEN:
 *   1. the agent token (Claude, scripts)
 *   2. a scoped, expiring upload ticket minted by /api/agent/upload-ticket
 *   3. a logged-in Stanley browser session (the jarvis_auth cookie)
 * A ticket is the narrowest: it can only upload text for the exact Internal IDs it
 * was minted for, until it expires.
 */
function sessionOk(req: Request): boolean {
  const expected = process.env.APP_SESSION_TOKEN;
  if (!expected) return false;
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(/(?:^|;\s*)jarvis_auth=([^;]+)/);
  return Boolean(m && m[1] === expected);
}

export async function POST(req: Request) {
  const ticketRaw = new URL(req.url).searchParams.get("ticket");
  const ticket = ticketRaw ? await verifyTicket(ticketRaw) : null;
  if (ticket && !ticket.ok) {
    return NextResponse.json({ error: `ticket rejected: ${ticket.reason}` }, { status: 401 });
  }
  if (!ticket?.ok && !agentAuthOk(req) && !sessionOk(req)) return unauthorized();

  let body: { docs?: unknown; agent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!Array.isArray(body.docs) || !body.docs.length) {
    return NextResponse.json({ error: "docs must be a non-empty array" }, { status: 400 });
  }
  if (body.docs.length > MAX_DOCS) {
    return NextResponse.json({ error: `docs capped at ${MAX_DOCS} per request`, received: body.docs.length }, { status: 400 });
  }

  const agent = callerAgent(req, body.agent);
  const rows: Record<string, unknown>[] = [];
  const errors: { index: number; problem: string }[] = [];

  (body.docs as Record<string, unknown>[]).forEach((raw, i) => {
    const internalId = coerceText(pick(raw, "internalId", "internal id", "nsid", "netsuiteInternalId"))?.replace(/\.0$/, "");
    const text = coerceText(pick(raw, "body", "text", "content", "recordText"));
    if (!internalId || !/^\d+$/.test(internalId)) return void errors.push({ index: i, problem: "missing/invalid internalId" });
    if (!text) return void errors.push({ index: i, problem: "missing body text" });
    if (text.length > MAX_CHARS) return void errors.push({ index: i, problem: `body exceeds ${MAX_CHARS} chars (${text.length})` });

    // Integrity check. A releasing agent hashes the text it audited; if what arrives
    // doesn't hash the same, the transfer truncated or altered it and the document is
    // NOT the audited package — reject rather than grade from a corrupted record.
    const computed = createHash("sha256").update(text).digest("hex");
    const claimed = coerceText(pick(raw, "sha256", "sha", "hash", "checksum"));
    if (claimed && claimed.toLowerCase() !== computed) {
      return void errors.push({
        index: i,
        problem: `sha256 mismatch for ${internalId} — released ${claimed.slice(0, 16)}…, received ${computed.slice(0, 16)}… (${text.length} chars). Document rejected; re-send.`,
      });
    }

    rows.push({
      netsuite_internal_id: internalId,
      doc_type: coerceText(pick(raw, "docType", "doc type", "type")) ?? "record_text",
      source: coerceText(pick(raw, "source")),
      title: coerceText(pick(raw, "title")),
      body: text,
      sha256: createHash("sha256").update(text).digest("hex"),
      captured_at: coerceDate(pick(raw, "capturedAt", "captured at", "date")) ?? null,
    });
  });

  if (!rows.length) return NextResponse.json({ error: "no usable docs", errors }, { status: 422 });

  // A ticket may only upload the exact IDs it was minted for.
  if (ticket?.ok && ticket.scopeIds) {
    const outside = [...new Set(rows.map((r) => String(r.netsuite_internal_id)).filter((id) => !ticket.scopeIds!.has(id)))];
    if (outside.length) {
      return NextResponse.json({
        error: "internal IDs outside this ticket's scope", outside: outside.slice(0, 20), outsideCount: outside.length,
        hint: "mint a ticket covering the released package, or split the upload",
      }, { status: 403 });
    }
  }

  const db = serviceClient();
  // Resolve company_id where the internal ID is known, so the UI can join later.
  const ids = [...new Set(rows.map((r) => String(r.netsuite_internal_id)))];
  const { data: companies } = await db.from("companies").select("id, netsuite_internal_id").in("netsuite_internal_id", ids);
  const companyByNsid = new Map((companies ?? []).map((c) => [String(c.netsuite_internal_id), c.id as string]));
  for (const r of rows) r.company_id = companyByNsid.get(String(r.netsuite_internal_id)) ?? null;

  // ignoreDuplicates: re-pushing the same text is a no-op, so an interrupted
  // upload can simply be restarted from the beginning without bookkeeping.
  const { error } = await db
    .from("lead_documents")
    .upsert(rows, { onConflict: "netsuite_internal_id,doc_type,sha256", ignoreDuplicates: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (ticket?.ok && ticket.id) await consumeTicket(ticket.id);

  const chars = rows.reduce((n, r) => n + String(r.body).length, 0);
  await logEvent("headhunter", "agent.documents_pushed", {
    summary: `${agent} pushed ${rows.length} lead documents (${Math.round(chars / 1000)}k chars, ${ids.length} leads)`,
    entity_type: "agent_bridge",
    meta: { agent, docs: rows.length, leads: ids.length, chars, errors: errors.length, via: ticket?.ok ? `ticket:${ticket.id}` : "token" },
  });

  return NextResponse.json({
    stored: rows.length, leads: ids.length, chars,
    unmatchedToCompany: rows.filter((r) => !r.company_id).length, errors,
    ...(ticket?.ok ? { ticketUsesRemaining: (ticket.remaining ?? 1) - 1 } : {}),
  });
}

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const url = new URL(req.url);
  const db = serviceClient();
  const internalId = url.searchParams.get("internalId");

  if (internalId) {
    const { data, error } = await db.from("lead_documents").select("*").eq("netsuite_internal_id", internalId).order("created_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ internalId, count: data?.length ?? 0, documents: data ?? [] });
  }

  const { count } = await db.from("lead_documents").select("*", { count: "exact", head: true });
  const { data: distinct } = await db.from("lead_documents").select("netsuite_internal_id");
  const covered = new Set((distinct ?? []).map((d) => String(d.netsuite_internal_id)));
  return NextResponse.json({
    documents: count ?? 0,
    leadsWithText: covered.size,
    hint: "GET ?internalId=<id> for one lead's documents; POST { docs: [...] } to push more",
  });
}
