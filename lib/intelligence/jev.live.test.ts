import { expect, it, vi } from "vitest";
import { evaluateEvidence } from "./jev";
// A direct opt-in smoke test was a paid-ledger bypass. Validate that the raw
// production adapter cannot dispatch without the globally reserved ticket.
it("never makes a direct live call without a budget ticket", async () => {
  const fetch = vi.fn();
  await expect(evaluateEvidence({ text: "Synthetic public fixture." }, { fetch }))
    .rejects.toThrow("dispatch_ticket_required");
  expect(fetch).not.toHaveBeenCalled();
});
