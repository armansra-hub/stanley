import { describe, expect, it } from "vitest";
import { customerReferenceCanContinue, customerReferenceProgressKey, type ReferenceProgress } from "./CustomerReferenceProgress";

const snapshot = (): ReferenceProgress => ({ asOf: "2026-09-28", total: 1, complete: 0, pending: 1, blocked: 0, running: 0,
  references: [{ id: "company", name: "Company", website: "https://company.com", status: "pending", answered: 0, totalQuestions: 47,
    sourcePages: 3, sourceGaps: 0, sourceAttempts: 3, checkpointUpdatedAt: "2026-09-29T01:00:00Z" }],
  run: { processed: 1, completed: 0, stoppedBy: "continued" } });

describe("finite customer reference continuation", () => {
  it("recognizes durable native mapping progress before any final answer is ready", () => {
    const before = snapshot(), next = structuredClone(before);
    next.references[0].checkpointUpdatedAt = "2026-09-29T01:04:00Z";
    expect(customerReferenceCanContinue(before, next)).toBe(true);
  });
  it("recognizes source attempts that resolve to an already captured page without inflating page counts", () => {
    const before = snapshot(), next = structuredClone(before);
    next.references[0].sourceAttempts = 4; next.run!.stoppedBy = "source_continuation";
    expect(customerReferenceCanContinue(before, next)).toBe(true);
  });
  it("stops when the durable checkpoint is unchanged", () => {
    const before = snapshot();
    expect(customerReferenceCanContinue(before, structuredClone(before))).toBe(false);
  });
  it.each(["provider_hold", "provider_error", "native_busy", "lease_changed", "source_lease_changed", "unconfirmed"])("stops for %s even when the checkpoint time changed", stoppedBy => {
    const before = snapshot(), next = structuredClone(before);
    next.references[0].checkpointUpdatedAt = "2026-09-29T01:04:00Z"; next.run!.stoppedBy = stoppedBy;
    expect(customerReferenceCanContinue(before, next)).toBe(false);
  });
  it("stops after completion and while another pass is running", () => {
    const before = snapshot(), next = structuredClone(before);
    next.references[0].answered = 47; next.pending = 0;
    expect(customerReferenceCanContinue(before, next)).toBe(false);
    next.pending = 1; next.running = 1;
    expect(customerReferenceCanContinue(before, next)).toBe(false);
  });
  it("does not treat display order as new work or mutate the response", () => {
    const before = snapshot(); before.references.push({ ...before.references[0], id: "another" });
    const next = structuredClone(before); next.references.reverse();
    expect(customerReferenceProgressKey(next)).toBe(customerReferenceProgressKey(before));
    expect(next.references[0].id).toBe("another");
  });
});
