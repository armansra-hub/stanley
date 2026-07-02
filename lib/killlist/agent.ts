import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, isWriteTool, needsConfirm, executeReadTool, describeAction } from "./agentTools";
import { applyKillActions, boardContext, type Action } from "./applyActions";
import { nowLocal } from "@/lib/missions/timeutil";

const MODEL = process.env.MODEL_CHAT || "claude-sonnet-5";

export interface PlanItem { action: Action; describe: string }
export interface AgentResult {
  reply: string;
  plan: PlanItem[]; // actions awaiting confirmation (deletes only)
  changed: boolean;
  messages: Anthropic.MessageParam[];
}

/**
 * Stanley's Kill List agent (Opus 4.8). Reads run free; most writes apply
 * immediately; destructive deletes queue a confirm card. Manual data ONLY — Jarvis
 * records what the user dictates and never invents company facts.
 */
export async function runKillListAgent(initial: Anthropic.MessageParam[], tz: string): Promise<AgentResult> {
  const client = new Anthropic();
  const messages = [...initial];
  const plan: PlanItem[] = [];
  let changed = false;

  const board = await boardContext();
  const system = `You are Stanley, the Kill List manager for a NetSuite account executive. RIGHT NOW it is ${nowLocal(tz).pretty} (timezone ${tz}).
- The Kill List is a MANUAL pipeline tracker for accounts already in motion. You ONLY record what the user tells you — NEVER research, enrich, guess, or invent a company's description, website, or any fact. If the user didn't say it, leave it blank.
- This is SEPARATE from Headhunter (prospecting) and from the general Missions list. Treat everything here as a pipeline lead, note, task, or stage.
- The ONE bridge: a task WITH a due date also becomes a Missions reminder + calendar invite. When you add/edit a dated task, tell the user it'll also show in Missions + send a calendar reminder.
- To act on an existing lead or task you MUST first call a read tool (list_leads / get_lead / list_lead_tasks) to get its id; refer to things by NAME to the user, never the raw id. Match names loosely/forgivingly (typos, partial, voice mis-transcriptions).
- Resolve relative dates ("today","tomorrow","Friday","EOD","next week") to local 'YYYY-MM-DDTHH:MM'. A bare date → 09:00; "EOD" → 17:00.
- A single message can contain MULTIPLE actions — do EVERY one (one tool call at a time).
- Most actions apply IMMEDIATELY — just do them, never ask permission, then briefly confirm what you did. The ONLY exception is delete_lead / delete_task, which the app holds for the user to confirm — for those, say you've queued it for confirmation (don't claim it's deleted yet).
- Be concise — a sentence or short list, no preamble.

Current board:
${board}`;

  for (let step = 0; step < 12; step++) {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      tools: TOOLS,
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      messages,
    });
    messages.push({ role: "assistant", content: resp.content });

    if (resp.stop_reason !== "tool_use") {
      const text = resp.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      return { reply: text || "Done.", plan, changed, messages };
    }
    const tu = resp.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!tu) return { reply: "Done.", plan, changed, messages };

    if (isWriteTool(tu.name)) {
      if (needsConfirm(tu.name)) {
        const describe = await describeAction(tu.name, tu.input);
        plan.push({ action: { name: tu.name, input: tu.input }, describe });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: `Queued for the user to confirm: ${describe}` }] });
      } else {
        const { results } = await applyKillActions([{ name: tu.name, input: tu.input }], tz);
        changed = true;
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: `Done: ${results[0] ?? tu.name}` }] });
      }
      continue;
    }

    const result = await executeReadTool(tu.name, tu.input, tz);
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: result }] });
  }
  return { reply: "Lined up several steps — confirm below.", plan, changed, messages };
}
