import { describe, it, expect } from "vitest";
import { planTaskBridge, missionPayloadForTask, reminderLeadMinutes, DEFAULT_TASK_MINUTES } from "./bridge";
import type { LeadTask } from "./types";

const base: Pick<LeadTask, "title" | "notes" | "due_at" | "remind_at" | "block_time" | "status" | "mission_id"> = {
  title: "Send proposal",
  notes: null,
  due_at: null,
  remind_at: null,
  block_time: false,
  status: "open",
  mission_id: null,
};

describe("planTaskBridge", () => {
  it("dated + open + no mission → create", () => {
    const op = planTaskBridge({ ...base, due_at: "2026-07-01T17:00:00Z" }, "Acme");
    expect(op.op).toBe("create");
    if (op.op === "create") expect(op.payload.title).toBe("Send proposal");
  });

  it("dated + open + existing mission → update", () => {
    const op = planTaskBridge({ ...base, due_at: "2026-07-01T17:00:00Z", mission_id: "m1" }, "Acme");
    expect(op.op).toBe("update");
  });

  it("no date + no mission → none (stays local to the lead)", () => {
    expect(planTaskBridge(base, "Acme").op).toBe("none");
  });

  it("date cleared but mission exists → cancel", () => {
    const op = planTaskBridge({ ...base, due_at: null, mission_id: "m1" }, "Acme");
    expect(op.op).toBe("cancel");
  });

  it("task done with mission → complete", () => {
    const op = planTaskBridge({ ...base, due_at: "2026-07-01T17:00:00Z", status: "done", mission_id: "m1" }, "Acme");
    expect(op.op).toBe("complete");
  });

  it("task done with no mission → none", () => {
    expect(planTaskBridge({ ...base, status: "done" }, "Acme").op).toBe("none");
  });

  it("deleted with mission → cancel (even if still dated)", () => {
    const op = planTaskBridge({ ...base, due_at: "2026-07-01T17:00:00Z", mission_id: "m1" }, "Acme", { deleted: true });
    expect(op.op).toBe("cancel");
  });

  it("deleted with no mission → none", () => {
    expect(planTaskBridge({ ...base, due_at: "2026-07-01T17:00:00Z" }, "Acme", { deleted: true }).op).toBe("none");
  });
});

describe("missionPayloadForTask", () => {
  it("returns null without a due date", () => {
    expect(missionPayloadForTask(base, "Acme")).toBeNull();
  });

  it("pinned reminder (block_time=false) → kind reminder, no scheduled window", () => {
    const p = missionPayloadForTask({ ...base, due_at: "2026-07-01T17:00:00Z" }, "Acme")!;
    expect(p.kind).toBe("reminder");
    expect(p.scheduled_start).toBeNull();
    expect(p.due_at).toBe("2026-07-01T17:00:00.000Z");
    expect(p.notes).toContain("Acme (Kill List)");
  });

  it("time-block (block_time=true) → kind task, window DEFAULT_TASK_MINUTES long", () => {
    const p = missionPayloadForTask({ ...base, due_at: "2026-07-01T17:00:00Z", block_time: true }, "Acme")!;
    expect(p.kind).toBe("task");
    expect(p.scheduled_start).toBe("2026-07-01T17:00:00.000Z");
    expect(new Date(p.scheduled_end!).getTime() - new Date(p.scheduled_start!).getTime()).toBe(DEFAULT_TASK_MINUTES * 60_000);
  });

  it("keeps the user's note and appends the lead tag", () => {
    const p = missionPayloadForTask({ ...base, due_at: "2026-07-01T17:00:00Z", notes: "Loop in CFO" }, "Acme")!;
    expect(p.notes).toContain("Loop in CFO");
    expect(p.notes).toContain("Acme (Kill List)");
  });
});

describe("reminderLeadMinutes", () => {
  it("null remind_at → null (uses the pref default)", () => {
    expect(reminderLeadMinutes("2026-07-01T17:00:00Z", null)).toBeNull();
  });
  it("computes minutes-before from remind_at", () => {
    expect(reminderLeadMinutes("2026-07-01T17:00:00Z", "2026-07-01T16:30:00Z")).toBe(30);
  });
  it("remind_at after due → clamps to 0", () => {
    expect(reminderLeadMinutes("2026-07-01T17:00:00Z", "2026-07-01T17:30:00Z")).toBe(0);
  });
});
