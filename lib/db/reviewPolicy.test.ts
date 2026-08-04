import { describe, expect, it } from "vitest";
import { latestHumanStatusByCompany } from "./reviewPolicy";

describe("durable human review policy", () => {
  it("keeps the latest explicit decision for each company", () => {
    const latest = latestHumanStatusByCompany([
      { ts: "2026-01-01T00:00:00Z", meta: { status: "reviewed", ids: ["a", "b"] } },
      { ts: "2026-02-01T00:00:00Z", meta: { status: "new", ids: ["a"] } },
      { ts: "2026-03-01T00:00:00Z", meta: { status: "dismissed", ids: ["b"] } },
    ]);
    expect(Object.fromEntries(latest)).toEqual({ b: "dismissed", a: "new" });
  });

  it("ignores malformed rows and older duplicate decisions", () => {
    const latest = latestHumanStatusByCompany([
      { ts: "2026-03-01T00:00:00Z", meta: { status: "reviewed", ids: ["a"] } },
      { ts: "2026-02-01T00:00:00Z", meta: { status: "dismissed", ids: ["a"] } },
      { ts: "2026-04-01T00:00:00Z", meta: { status: "exported_csv", ids: ["x"] } },
      { ts: "2026-05-01T00:00:00Z", meta: null },
    ]);
    expect(Object.fromEntries(latest)).toEqual({ a: "reviewed" });
  });
});
