import { NextRequest } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { runChatStream } from "@/lib/chat/run";
import { executeWriteTool } from "@/lib/chat/tools";

// Streaming chat (SSE). Body { messages, decision?, pending? }. When a pending
// write is present, we execute/deny it first, then stream the continuation —
// so this one endpoint covers both the initial turn and the post-confirm turn.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: {
    messages?: Anthropic.MessageParam[];
    decision?: "allow" | "deny";
    pending?: { tool_use_id: string; name: string; input: unknown };
  };
  try {
    body = await req.json();
  } catch {
    return new Response("invalid JSON", { status: 400 });
  }

  let messages = body.messages ?? [];
  if (body.pending) {
    let content: string;
    let isError = false;
    try {
      if (body.decision === "allow") content = await executeWriteTool(body.pending.name, body.pending.input);
      else {
        content = "User declined this action.";
        isError = true;
      }
    } catch (e) {
      content = `Action failed: ${e instanceof Error ? e.message : String(e)}`;
      isError = true;
    }
    messages = [
      ...messages,
      { role: "user", content: [{ type: "tool_result", tool_use_id: body.pending.tool_use_id, content, is_error: isError }] },
    ];
  }

  const encoder = new TextEncoder();
  const rs = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runChatStream(messages)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        }
      } catch (e) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: e instanceof Error ? e.message : String(e) })}\n\n`));
      }
      controller.close();
    },
  });

  return new Response(rs, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
