import type { Mission } from "./types";

/**
 * Pure day-planner (client-safe): fits today's tasks into the free gaps of the
 * work day, around the Outlook busy blocks + any tasks that already have a fixed
 * time. Greedy, earliest-fit, high-priority first. No side effects — re-runs
 * whenever missions change, so the in-app calendar stays live.
 */

export interface PlanBlock {
  kind: "busy" | "task";
  title: string;
  start: number; // epoch ms
  end: number;
  missionId?: string;
  priority?: string;
  fixed?: boolean; // task already had a scheduled time
}

export interface DayPlan {
  blocks: PlanBlock[];
  unscheduled: Mission[]; // tasks that didn't fit in the work day
}

interface Interval { start: number; end: number }

const PRI: Record<string, number> = { high: 0, medium: 1, low: 2 };
const ms = (iso: string) => new Date(iso).getTime();
const durationFor = (m: Mission) => {
  if (m.scheduled_start && m.scheduled_end) return ms(m.scheduled_end) - ms(m.scheduled_start);
  return (m.kind === "task" ? 30 : 15) * 60_000;
};

/** Subtract occupied intervals from [winStart, winEnd] → free gaps. */
export function freeSlots(winStart: number, winEnd: number, occupied: Interval[]): Interval[] {
  const merged: Interval[] = [];
  for (const o of [...occupied].sort((a, b) => a.start - b.start)) {
    const s = Math.max(o.start, winStart), e = Math.min(o.end, winEnd);
    if (e <= s) continue;
    const last = merged[merged.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else merged.push({ start: s, end: e });
  }
  const gaps: Interval[] = [];
  let cursor = winStart;
  for (const o of merged) {
    if (o.start > cursor) gaps.push({ start: cursor, end: o.start });
    cursor = Math.max(cursor, o.end);
  }
  if (cursor < winEnd) gaps.push({ start: cursor, end: winEnd });
  return gaps;
}

export function planDay(opts: {
  workStart: number;
  workEnd: number;
  busy: { start: string; end: string }[];
  missions: Mission[]; // today's open/snoozed missions
}): DayPlan {
  const { workStart, workEnd } = opts;
  const busyBlocks: PlanBlock[] = opts.busy.map((b) => ({ kind: "busy", title: "Busy", start: ms(b.start), end: ms(b.end) }));

  // Tasks with a fixed time today → placed as-is.
  const fixed: PlanBlock[] = [];
  const flexible: Mission[] = [];
  for (const m of opts.missions) {
    if (m.scheduled_start) {
      const s = ms(m.scheduled_start);
      const e = m.scheduled_end ? ms(m.scheduled_end) : s + durationFor(m);
      fixed.push({ kind: "task", title: m.title, start: s, end: e, missionId: m.id, priority: m.priority, fixed: true });
    } else {
      flexible.push(m);
    }
  }

  // Free gaps within the work day, around busy + fixed task blocks.
  const occupied: Interval[] = [...busyBlocks, ...fixed].map((b) => ({ start: b.start, end: b.end }));
  const gaps = freeSlots(workStart, workEnd, occupied);

  // Earliest-fit, high priority first.
  flexible.sort((a, b) => (PRI[a.priority] ?? 1) - (PRI[b.priority] ?? 1) || (a.due_at ?? "").localeCompare(b.due_at ?? ""));
  const fitted: PlanBlock[] = [];
  const unscheduled: Mission[] = [];
  for (const m of flexible) {
    const dur = durationFor(m);
    const slot = gaps.find((g) => g.end - g.start >= dur);
    if (!slot) { unscheduled.push(m); continue; }
    fitted.push({ kind: "task", title: m.title, start: slot.start, end: slot.start + dur, missionId: m.id, priority: m.priority });
    slot.start += dur; // consume the front of the gap
  }

  const blocks = [...busyBlocks, ...fixed, ...fitted].sort((a, b) => a.start - b.start);
  return { blocks, unscheduled };
}
