import { describe, expect, it } from "vitest";
import { candidateVerdictIsPublishable, evidenceTextFromHtml } from "./candidateReview";

describe("candidate evidence extraction", () => {
  it("keeps article text while removing executable and layout markup", () => {
    const text = evidenceTextFromHtml(`
      <html><head><style>.x{display:none}</style><script>steal()</script></head>
      <body><h1>Acme Freight opens a new warehouse</h1><p>Acme Freight &amp; Logistics expanded in Phoenix.</p></body></html>
    `);
    expect(text).toBe("Acme Freight opens a new warehouse Acme Freight & Logistics expanded in Phoenix.");
    expect(text).not.toContain("steal");
  });
});

describe("candidate verification gate", () => {
  const verified = {
    exact_company: true,
    concrete_event: true,
    event: "press" as const,
    is_acquirer: false,
    confidence: "high" as const,
    reason: "The article names the exact company and a new office.",
  };

  it("publishes only exact, concrete, high-confidence matching events", () => {
    expect(candidateVerdictIsPublishable("press", verified)).toBe(true);
    expect(candidateVerdictIsPublishable("press", { ...verified, confidence: "medium" })).toBe(false);
    expect(candidateVerdictIsPublishable("hiring", verified)).toBe(false);
    expect(candidateVerdictIsPublishable("press", { ...verified, exact_company: false })).toBe(false);
  });

  it("requires the TAM company to be the acquirer for an M&A trigger", () => {
    const ma = { ...verified, event: "ma" as const };
    expect(candidateVerdictIsPublishable("ma", ma)).toBe(false);
    expect(candidateVerdictIsPublishable("ma", { ...ma, is_acquirer: true })).toBe(true);
  });
});
