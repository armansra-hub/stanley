import { afterEach, describe, expect, it, vi } from "vitest";
import { logMetricFailure } from "./metricDiagnostics";
afterEach(() => vi.restoreAllMocks());
describe("bounded reporting diagnostics", () => {
  it.each(["57014", "PGRST202"])("retains only the standard database code %s", code => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logMetricFailure("cost", { code, message: "secret query content", details: "secret connection" });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("intelligence.metrics_unavailable", { metric: "cost", code });
  });
  it.each([null, new Error("secret connection"), { code: "Bearer private credential", message: "secret query" }])("does not emit unknown errors or private data", error => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    logMetricFailure("research_progress", error);
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("intelligence.metrics_unavailable", { metric: "research_progress", code: "unknown" });
  });
});
