import { describe, expect, it } from "vitest";
import { scoreTalUrgency } from "./urgency";
describe("scoreTalUrgency", () => {
  const now = new Date("2026-08-01T12:00:00Z");
  it("prioritizes a fresh alert and current SQL over a dormant high-quality account", () => {
    const urgent = scoreTalUrgency({ tamScore: 55, talAlert: true, lastSqlDate: "2026-07-20", triggers: [{ type: "finance_hire", live: 70, signalDate: "2026-07-29" }] }, now);
    expect(urgent.score).toBeGreaterThan(scoreTalUrgency({ tamScore: 90 }, now).score);
    expect(urgent.reasons).toContain("New TAL alert");
  });
  it("sinks a record marked dead", () => expect(scoreTalUrgency({ tamScore: 100, talAlert: true, recordDead: true }, now)).toEqual({ score: 0, reasons: ["Record marked dead"] }));
});
