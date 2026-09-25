import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IntelligenceBudgetDetails } from "./IntelligenceBudget";
import { providerBudget } from "@/test/jev-budget-status-fixture";

describe("provider credit status display", () => {
  it("shows no artificial allowance, expiry or invented remaining provider balance", () => {
    const html = renderToStaticMarkup(createElement(IntelligenceBudgetDetails, { budget: providerBudget }));
    expect(html).toContain("No Stanley spending cap");
    expect(html).toContain("Not available in Stanley");
    expect(html).toContain("Accounted today");
    expect(html).not.toContain("$0.50");
    expect(html).not.toContain("Remaining in this window");
    expect(html).not.toContain("Next window:");
    expect(html).not.toContain("allowance expires");
    expect(html).not.toContain("Awaiting confirmation");
  });
  it("distinguishes a generic billing refusal from confirmed insufficient credit", () => {
    const html = renderToStaticMarkup(createElement(IntelligenceBudgetDetails, { budget: {
      ...providerBudget, enabled: false, blockedReason: "provider_billing_unavailable",
    } }));
    expect(html).toContain("TypeSafe rejected billing for a request");
    expect(html).not.toContain("reported insufficient credit");
    expect(html).not.toContain("$0.00 remaining");
  });
  it("keeps genuine operational holds visible without presenting them as spending caps", () => {
    const html = renderToStaticMarkup(createElement(IntelligenceBudgetDetails, { budget: {
      ...providerBudget, enabled: false, blockedReason: "processing_disabled",
    } }));
    expect(html).toContain("Jev processing is paused");
    expect(html).toContain("Waiting: processing disabled");
    expect(html).toContain("Stanley does not purchase credits automatically");
  });
});