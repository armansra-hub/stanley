import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { nowLocal } from "@/lib/missions/timeutil";

/**
 * Log-a-call: turn a spoken post-call debrief into (1) a tidy activity-log note and
 * (2) any follow-up tasks the user mentioned, with dates. Runs on Opus 4.8. NEVER
 * invents facts — only structures what's in the transcript.
 */

const MODEL = process.env.MODEL_CHAT || "claude-sonnet-4-6";

export interface CallTask { title: string; local_due: string | null; block_time: boolean }
export interface CallLog { summary: string; tasks: CallTask[] }

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "A concise activity-log entry summarizing what happened on the call. Plain past tense. Only facts stated." },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "short imperative follow-up, e.g. 'Send pricing'" },
          local_due: { type: ["string", "null"], description: "naive local 'YYYY-MM-DDTHH:MM' if a time/date was stated or clearly implied, else null" },
          block_time: { type: "boolean", description: "true only if the user wants a work block reserved; default false (a reminder)" },
        },
        required: ["title", "local_due", "block_time"],
      },
    },
  },
  required: ["summary", "tasks"],
} as const;

export async function parseCallLog(transcript: string, tz: string): Promise<CallLog> {
  const now = nowLocal(tz);
  const system = `You are Stanley, assistant to a NetSuite account executive who just finished a sales call and is dictating what happened.
RIGHT NOW it is ${now.pretty} (local ${now.iso}, timezone ${tz}). Resolve relative dates ("Friday","next week","tomorrow","EOD") against that; a bare date → 09:00.
Produce:
1) summary — a clean, concise activity-log note of what happened (past tense, only what was said; do NOT invent details, numbers, or names not in the transcript).
2) tasks — every follow-up the user mentioned or clearly committed to. Give each a short imperative title and a local_due if a time was stated/implied (else null). block_time is false unless they explicitly want time reserved to do the work.
If there are no real follow-ups, return an empty tasks array. Never fabricate tasks.`;

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: "user", content: transcript }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const out = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!out) return { summary: transcript.trim(), tasks: [] };
    const parsed = JSON.parse(out) as CallLog;
    return { summary: parsed.summary?.trim() || transcript.trim(), tasks: (parsed.tasks ?? []).filter((t) => t.title?.trim()) };
  } catch {
    return { summary: transcript.trim(), tasks: [] }; // fall back to filing the raw note
  }
}
