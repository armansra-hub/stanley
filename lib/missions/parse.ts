import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { buildRRule, type RecurrenceIntent } from "./recurrence";
import { wallClockToUtc, nowLocal } from "./timeutil";

/**
 * Natural-language → one OR MORE structured mission drafts (confirm-before-apply).
 * Runs on Opus 4.8 so it actually decomposes compound requests ("remind me to do
 * A, block time for B tomorrow, and follow up on C Friday" → three missions). The
 * LLM reasons in the user's LOCAL time and emits naive local datetimes; we resolve
 * them to UTC + build the RRULE ourselves (no LLM timezone/RRULE math).
 */

const MODEL = process.env.MODEL_CHAT || "claude-sonnet-5";

export interface MissionDraft {
  title: string;
  kind: "task" | "reminder";
  priority: "low" | "medium" | "high";
  due_at: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  all_day: boolean;
  is_recurring: boolean;
  rrule: string | null;
  notes: string | null;
  when_label: string;
}

const MISSION_ITEM = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    kind: { type: "string", enum: ["task", "reminder"] },
    priority: { type: "string", enum: ["low", "medium", "high"] },
    local_due: { type: ["string", "null"], description: "naive local datetime 'YYYY-MM-DDTHH:MM', or null" },
    duration_minutes: { type: ["number", "null"] },
    all_day: { type: "boolean" },
    recurrence_freq: { type: "string", enum: ["none", "daily", "weekdays", "weekly", "monthly"] },
    recurrence_interval: { type: "number" },
    recurrence_byweekday: { type: "array", items: { type: "number" }, description: "0=Mon..6=Sun, only for weekly" },
    notes: { type: ["string", "null"] },
  },
  required: ["title", "kind", "priority", "local_due", "duration_minutes", "all_day", "recurrence_freq", "recurrence_interval", "recurrence_byweekday", "notes"],
} as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { missions: { type: "array", items: MISSION_ITEM } },
  required: ["missions"],
} as const;

interface RawItem {
  title: string;
  kind: "task" | "reminder";
  priority: "low" | "medium" | "high";
  local_due: string | null;
  duration_minutes: number | null;
  all_day: boolean;
  recurrence_freq: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  recurrence_interval: number;
  recurrence_byweekday: number[];
  notes: string | null;
}

function finalize(r: RawItem, tz: string): MissionDraft {
  const due = r.local_due ? wallClockToUtc(r.local_due, tz) : null;
  const dueIso = due && !Number.isNaN(due.getTime()) ? due.toISOString() : null;

  let scheduled_start: string | null = null;
  let scheduled_end: string | null = null;
  if (r.kind === "task" && dueIso && !r.all_day) {
    scheduled_start = dueIso;
    scheduled_end = new Date(due!.getTime() + (r.duration_minutes ?? 30) * 60_000).toISOString();
  }

  const isRec = r.recurrence_freq !== "none";
  let rrule: string | null = null;
  if (isRec) {
    const intent: RecurrenceIntent = { freq: r.recurrence_freq as RecurrenceIntent["freq"], interval: r.recurrence_interval, byweekday: r.recurrence_byweekday };
    rrule = buildRRule(intent);
  }

  const fmt = (iso: string) => new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  const recLabel = isRec ? (r.recurrence_freq === "weekdays" ? "every weekday" : r.recurrence_freq) : "";
  const when_label = [dueIso ? fmt(dueIso) : "no date", recLabel].filter(Boolean).join(" · ");

  return {
    title: r.title.trim(),
    kind: r.kind,
    priority: r.priority,
    due_at: dueIso,
    scheduled_start,
    scheduled_end,
    all_day: r.all_day,
    is_recurring: isRec,
    rrule,
    notes: r.notes?.trim() || null,
    when_label,
  };
}

export async function parseMissions(text: string, tz: string): Promise<MissionDraft[]> {
  const now = nowLocal(tz);
  const system = `You are Stanley, a sharp executive assistant for a NetSuite account executive. Turn the user's message into a list of structured tasks/reminders.
RIGHT NOW it is ${now.pretty} (local datetime ${now.iso}, timezone ${tz}). Resolve every relative date ("today", "tomorrow", "Friday", "next week", "in 2 hours", "end of day") against that.
CRITICAL: a single message often contains MULTIPLE separate tasks — return EVERY one as its own mission. Never merge distinct tasks, never drop one. If the user lists three things, return three missions.
Per mission:
- title: a short imperative title (strip "remind me to" / "I need to" filler).
- kind: "task" if it occupies a block of time (meeting, prep, a work block); "reminder" if it's a quick point-in-time nudge.
- local_due: the naive LOCAL datetime "YYYY-MM-DDTHH:MM" it's due/happens. If only a date is given, default 09:00. Use a sensible time from context ("morning"→09:00, "afternoon"→14:00, "EOD"→17:00). null only if no time is implied at all.
- duration_minutes: for a "task" block, the length (default 30 if unstated); null for a point reminder.
- all_day: true only for explicitly all-day items.
- recurrence_freq: "none" unless it repeats. "weekdays"=Mon–Fri; "weekly" + recurrence_byweekday (0=Mon..6=Sun) for specific days; "daily"/"monthly" as stated. recurrence_interval default 1 ("every 2 weeks"→weekly, interval 2).
- priority: infer (urgent/ASAP/important/EOD→high; default medium).
- notes: any extra useful detail, else null.
Be thorough and precise — capture exactly what the user asked for, all of it.`;

  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 3000,
      system,
      messages: [{ role: "user", content: text }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const out = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!out) return [];
    const parsed = JSON.parse(out) as { missions: RawItem[] };
    return (parsed.missions ?? []).map((r) => finalize(r, tz)).filter((d) => d.title);
  } catch {
    return [];
  }
}
