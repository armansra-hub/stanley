import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AccountHiring from "./AccountHiring";
afterEach(() => vi.unstubAllGlobals());
describe("hiring coverage unknowns", () => {
  it("keeps an empty stored baseline distinct from no hiring", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(React.createElement(AccountHiring, { hiring: { boards: [], scans: [], basis: "Stored scans" }, coverage: "available" }));
    expect(html).toContain("No job-board baseline is stored");
    expect(html).toContain("does not establish that the company is not hiring");
  });
  it("reports an unavailable read without calling it a quiet job board", () => {
    vi.stubGlobal("React", React);
    const html = renderToStaticMarkup(React.createElement(AccountHiring, { hiring: null, coverage: "unavailable" }));
    expect(html).toContain("Hiring data could not be loaded");
    expect(html).toContain("Hiring activity is unknown");
    expect(html).not.toContain("0 open");
  });
});
