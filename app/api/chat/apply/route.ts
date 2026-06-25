import { NextRequest, NextResponse } from "next/server";
import type Anthropic from "@anthropic-ai/sdk";
import { runChat } from "@/lib/chat/run";
import { executeWriteTool } from "@/lib/chat/tools";

// Confirm-before-apply: the client calls this after the user approves (or
// declines) a pending write. We run the tool (or record a decline), feed the
// result back, and continue the agent loop.
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
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { messages, decision, pending } = body;
  if (!Array.isArray(messages) || !pending) {
    return NextResponse.json({ error: "messages[] and pending required" }, { status: 400 });
  }

  let content: string;
  let isError = false;
  try {
    if (decision === "allow") {
      content = await executeWriteTool(pending.name, pending.input);
    } else {
      content = "User declined this action.";
      isError = true;
    }
  } catch (e) {
    content = `Action failed: ${e instanceof Error ? e.message : String(e)}`;
    isError = true;
  }

  const next: Anthropic.MessageParam[] = [
    ...messages,
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: pending.tool_use_id, content, is_error: isError }],
    },
  ];

  try {
    const turn = await runChat(next);
    return NextResponse.json(turn);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
