import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: vi.fn() }));
import { parseResearchProgress } from "./researchProgress";
describe("research progress availability", () => {
  const valid = { available: true, scope: "eligible_tam", asOf: "2026-09-21T02:00:00Z",
    accounts: { total: 10, withEvidence: 8, withInterpretation: 7, caughtUp: 2, awaitingInterpretation: 3, blockedInterpretation: 1,
      researchReady: 4, researchRunning: 1, sourceRetry: 1, researchFailed: 0, discoveryCheckDue: 0 },
    processing: { pending: 12 }, lastHour: { newInterpretationJobs: 20, completedInterpretationJobs: 19 } };
  it("preserves separate first-read and caught-up counts", () => { expect(parseResearchProgress(valid)).toEqual(valid); });
  it("does not present unavailable or malformed reads as zero work", () => {
    for (const value of [null, {}, { ...valid, available: false }, { ...valid, accounts: { ...valid.accounts, caughtUp: -1 } }, { ...valid, processing: {} }])
      expect(parseResearchProgress(value)).toEqual({ available: false });
  });
});
