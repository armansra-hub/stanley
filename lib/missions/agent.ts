import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { TOOLS, isWriteTool, needsConfirm, executeReadTool, describeAction } from "./agentTools";
import { nowLocal } from "./timeutil";
import { applyActions, type Action } from "./applyActions";

const MODEL = process.env.MODEL_CHAT || "claude-sonnet-5";

export interface PlanItem { action: Action; describe: string }
export interface AgentResult {
  reply: string;
  plan: PlanItem[]; // only actions awaiting confirmation (deletes)
  changed: boolean; // a write was applied during the turn → caller should refresh
  messages: Anthropic.MessageParam[];
}

/**
 * Stanley's agent loop (Opus 4.8). Read tools execute and feed back; WRITE tools
 * are queued (dry-run) into a plan the user confirms before anything applies. A
 * single message can produce many actions — they all collect into one plan.
 */
export async function runMissionsAgent(initial: Anthropic.MessageParam[], tz: string): Promise<AgentResult> {
  const client = new Anthropic();
  const messages = [...initial];
  const plan: PlanItem[] = [];
  let changed = false;

  const system = `You are Stanley, a sharp executive assistant managing a NetSuite account executive's tasks + calendar. RIGHT NOW it is ${nowLocal(tz).pretty} (timezone ${tz}).
- This is the Missions app — tasks, reminders, and calendar ONLY. It is completely SEPARATE from "Headhunter" (a different prospecting tool). Treat EVERYTHING the user mentions as one of THEIR MISSIONS. Never assume a name refers to Headhunter, never mention prospecting/companies on your own, and never get "confused" between the two.
- The user's "tasks", "reminders", "blocks", and anything they name (e.g. "the websights prospecting" / "my demo prep") are MISSIONS here. When they reference one — even loosely, even if voice mis-transcribed it ("table", a typo, a partial name) — FIRST call list_missions and match it by title. NEVER refuse or claim you can't manage it.
- The ONLY time you touch Headhunter is if the user EXPLICITLY asks to link a task to a prospecting company (e.g. "link this to the Acme prospect"). Then, and only then, use find_company. Otherwise never call it.
- Match names LOOSELY and forgivingly: accept typos, voice mis-transcriptions, capitalization, and partial/approximate names. "websites prospecting" = "Websights Prospecting"; "the demo one" = the demo-prep task; "the 2 o'clock" = whatever's at 2pm. If exactly ONE mission is a reasonable match, just use it — do NOT bounce it back over a one-letter spelling difference. Only ask to clarify when several missions plausibly match or nothing is close.
- To CHANGE anything about an existing mission — title, time, priority, notes, or RECURRENCE (e.g. "make it Monday/Wednesday/Friday" → edit_mission with recurrence_freq:"weekly", recurrence_byweekday:[0,2,4]) — call edit_mission after finding its id.
- To act on an existing mission you MUST first call list_missions to get its id; refer to missions by TITLE to the user, never the raw id.
- Resolve relative dates ("today","tomorrow","Friday","next week","EOD","in 2 hours") to a local 'YYYY-MM-DDTHH:MM'. A bare date defaults to 09:00; "morning"→09:00, "afternoon"→14:00, "EOD"→17:00.
- A single message often contains MULTIPLE actions — do EVERY one (call tools one at a time, never drop any).
- "Plan/organize my day" → call plan_day. "Find time" → find_free_slots. A follow-up cadence → create_cadence (no company link unless they ask for one).
- Just DO what's asked — most write actions (create, complete, dismiss, reschedule, snooze, edit, plan_day, cadence, prefs) apply IMMEDIATELY. Never ask the user for permission. After acting, briefly confirm what you did. The ONLY exception is delete_mission, which the app holds for the user to confirm — for a delete, say you've queued it for confirmation (don't claim it's deleted yet).
- Be concise — a sentence or a short list, no preamble.`;

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
      const describe = await describeAction(tu.name, tu.input, tz);
      if (needsConfirm(tu.name)) {
        // destructive → hold for explicit confirmation
        plan.push({ action: { name: tu.name, input: tu.input }, describe });
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: `Queued for the user to confirm: ${describe}` }] });
      } else {
        // everything else → apply now
        const { results } = await applyActions([{ name: tu.name, input: tu.input }], tz);
        changed = true;
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: `Done: ${results[0] ?? describe}` }] });
      }
      continue;
    }

    const result = await executeReadTool(tu.name, tu.input, tz);
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tu.id, content: result }] });
  }
  return { reply: "Lined up several steps — confirm below.", plan, changed, messages };
}
