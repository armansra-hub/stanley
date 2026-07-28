import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/supabase/server";
import { agentAuthOk, callerAgent, unauthorized } from "@/lib/agent/auth";

/**
 * The live status board — what each agent is doing right now, and how far along.
 *
 * This exists because Codex spent twelve days on a regrade with no way to say so.
 * A running job heartbeats here, so "still working" and "silently stalled" stop
 * looking identical: a stale heartbeat_at is visible, silence is not.
 *
 * POST /api/agent/status { taskId?, title, state?, done?, total?, note?, detail? }
 *   omit taskId to open a task; pass the returned id to update or finish it.
 * GET  /api/agent/status?all=1 — the board (live tasks by default)
 */
export const dynamic = "force-dynamic";

const STATES = new Set(["queued", "running", "blocked", "done", "failed"]);

export async function GET(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  const url = new URL(req.url);
  const db = serviceClient();
  let q = db.from("agent_tasks").select("*").order("heartbeat_at", { ascending: false }).limit(50);
  if (url.searchParams.get("all") !== "1") q = q.in("state", ["queued", "running", "blocked"]);
  const { data, error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = Date.now();
  const tasks = (data ?? []).map((t) => {
    const staleMin = Math.round((now - new Date(t.heartbeat_at as string).getTime()) / 60000);
    return {
      ...t,
      minutesSinceHeartbeat: staleMin,
      // A running task that hasn't checked in for half an hour is the shape of a
      // stall — surfaced rather than left for someone to notice days later.
      looksStalled: t.state === "running" && staleMin > 30,
      percent: t.total ? Math.round((Number(t.done) / Number(t.total)) * 100) : null,
    };
  });
  return NextResponse.json({ count: tasks.length, tasks });
}

export async function POST(req: Request) {
  if (!agentAuthOk(req)) return unauthorized();
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const agent = callerAgent(req, body.agent);
  const state = body.state ? String(body.state).toLowerCase() : undefined;
  if (state && !STATES.has(state)) {
    return NextResponse.json({ error: `state must be one of ${[...STATES].join(", ")}` }, { status: 400 });
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = { heartbeat_at: now };
  if (state) patch.state = state;
  if (body.title) patch.title = String(body.title).slice(0, 300);
  if (body.done !== undefined) patch.done = Number(body.done) || 0;
  if (body.total !== undefined) patch.total = body.total === null ? null : Number(body.total) || 0;
  if (body.note !== undefined) patch.note = body.note === null ? null : String(body.note).slice(0, 2000);
  if (body.detail && typeof body.detail === "object") patch.detail = body.detail;
  if (state === "done" || state === "failed") patch.finished_at = now;

  const db = serviceClient();
  if (typeof body.taskId === "string" && body.taskId) {
    const { data, error } = await db.from("agent_tasks").update(patch).eq("id", body.taskId).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ updated: true, task: data });
  }

  if (!body.title) return NextResponse.json({ error: "title is required to open a task" }, { status: 400 });
  const { data, error } = await db.from("agent_tasks").insert({ agent, ...patch }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ created: true, taskId: data?.id, task: data });
}
