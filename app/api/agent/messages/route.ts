import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";

/**
 * The backroom mailbox. Durable notes between Stanley's two agents (and Arman),
 * so a handoff survives the end of whichever session wrote it.
 *
 * GET  /api/agent/messages?to=claude&unread=1&limit=50   — read your inbox
 *      (reading marks messages read unless you pass &peek=1)
 * POST /api/agent/messages { to, subject, body?, kind?, ref?, threadId? }
 */
export const dynamic = "force-dynamic";

const KINDS = new Set(["note", "status", "question", "answer", "handoff", "error", "contract"]);
const AGENTS = new Set(["codex", "claude", "arman", "all"]);

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const url = new URL(req.url);
  const to = (url.searchParams.get("to") ?? callerAgent(req)).toLowerCase();
  const unreadOnly = url.searchParams.get("unread") === "1";
  const peek = url.searchParams.get("peek") === "1";
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200);

  const db = serviceClient();
  let q = db.from("agent_messages").select("*").in("to_agent", [to, "all"]).order("created_at", { ascending: false }).limit(limit);
  if (unreadOnly) q = q.is("read_at", null);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const messages = data ?? [];
  const unreadIds = messages.filter((m) => !m.read_at).map((m) => m.id);
  if (!peek && unreadIds.length) {
    await db.from("agent_messages").update({ read_at: new Date().toISOString() }).in("id", unreadIds);
  }
  return NextResponse.json({ inbox: to, count: messages.length, markedRead: peek ? 0 : unreadIds.length, messages });
}

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const from = callerAgent(req, body.from ?? body.agent);
  const to = String(body.to ?? "claude").toLowerCase();
  const subject = String(body.subject ?? "").trim();
  const kind = String(body.kind ?? "note").toLowerCase();

  if (!AGENTS.has(to)) return NextResponse.json({ error: `to must be one of ${[...AGENTS].join(", ")}` }, { status: 400 });
  if (!subject) return NextResponse.json({ error: "subject is required" }, { status: 400 });
  if (!KINDS.has(kind)) return NextResponse.json({ error: `kind must be one of ${[...KINDS].join(", ")}` }, { status: 400 });

  const { data, error } = await serviceClient().from("agent_messages").insert({
    from_agent: from,
    to_agent: to,
    kind,
    subject: subject.slice(0, 300),
    body: body.body ? String(body.body).slice(0, 20000) : null,
    ref: body.ref && typeof body.ref === "object" ? body.ref : {},
    thread_id: typeof body.threadId === "string" ? body.threadId : null,
  }).select("id, created_at").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sent: true, id: data?.id, from, to, kind });
}
