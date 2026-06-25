import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { CHAT_TOOLS, isWriteTool, executeReadTool, describeWrite } from "./tools";

const MODEL_CHAT = process.env.MODEL_CHAT || "claude-opus-4-8";

const SYSTEM = `You are Jarvis, a concise CRM-style assistant for a NetSuite account executive's prospecting dashboard.

The dashboard holds discovered + imported companies, each with a deterministic 0–100 signal_score, an A/B/C tier, a subindustry, a state, and signals (each tied to real source evidence).

Rules:
- To find companies, call query_companies (it returns ids you need for any write).
- Refer to companies by NAME when talking to the user, never raw ids.
- Never invent facts; ground answers in tool results and the signal evidence.
- Be brief — a sentence or two, or a short list. No preamble.
- For write actions (dismiss, mark_exported, add_note, update_territory_config), just call the tool — the app shows the user a confirmation before anything is applied, so you don't need to ask permission yourself. Call one tool at a time.`;

export type ChatTurn =
  | { type: "message"; text: string; messages: Anthropic.MessageParam[] }
  | {
      type: "confirm";
      summary: string;
      pending: { tool_use_id: string; name: string; input: unknown };
      messages: Anthropic.MessageParam[];
    };

/**
 * Run the agent loop. Read tools execute and feed back automatically; the first
 * WRITE tool pauses and returns a confirmation for the user (confirm-before-apply).
 */
export async function runChat(initial: Anthropic.MessageParam[]): Promise<ChatTurn> {
  const client = new Anthropic();
  const messages = [...initial];

  for (let i = 0; i < 8; i++) {
    const resp = await client.messages.create({
      model: MODEL_CHAT,
      max_tokens: 1500,
      system: SYSTEM,
      tools: CHAT_TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      return { type: "message", text: text || "(done)", messages };
    }

    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) return { type: "message", text: "(no tool call)", messages };

    if (isWriteTool(toolUse.name)) {
      const summary = await describeWrite(toolUse.name, toolUse.input);
      return {
        type: "confirm",
        summary,
        pending: { tool_use_id: toolUse.id, name: toolUse.name, input: toolUse.input },
        messages,
      };
    }

    const result = await executeReadTool(toolUse.name, toolUse.input);
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUse.id, content: result }],
    });
  }

  return { type: "message", text: "Stopped after several steps — try narrowing the request.", messages };
}

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool"; name: string }
  | { type: "done"; messages: Anthropic.MessageParam[] }
  | {
      type: "confirm";
      summary: string;
      pending: { tool_use_id: string; name: string; input: unknown };
      messages: Anthropic.MessageParam[];
    };

/** Streaming variant: yields text deltas live; pauses on the first write tool. */
export async function* runChatStream(initial: Anthropic.MessageParam[]): AsyncGenerator<ChatStreamEvent> {
  const client = new Anthropic();
  const messages = [...initial];

  for (let i = 0; i < 8; i++) {
    const stream = client.messages.stream({
      model: MODEL_CHAT,
      max_tokens: 1500,
      system: SYSTEM,
      tools: CHAT_TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    });
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        yield { type: "delta", text: ev.delta.text };
      }
    }
    const resp = await stream.finalMessage();
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      yield { type: "done", messages };
      return;
    }
    const toolUse = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      yield { type: "done", messages };
      return;
    }
    if (isWriteTool(toolUse.name)) {
      const summary = await describeWrite(toolUse.name, toolUse.input);
      yield { type: "confirm", summary, pending: { tool_use_id: toolUse.id, name: toolUse.name, input: toolUse.input }, messages };
      return;
    }
    yield { type: "tool", name: toolUse.name };
    const result = await executeReadTool(toolUse.name, toolUse.input);
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolUse.id, content: result }] });
  }
  yield { type: "done", messages };
}
