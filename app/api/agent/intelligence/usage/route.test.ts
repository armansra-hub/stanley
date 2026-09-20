import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const read = vi.hoisted(() => vi.fn());
vi.mock("@/lib/intelligence/costMetrics", () => ({ readJevCostMetrics: read }));
import { GET } from "./route";
beforeEach(() => {
  read.mockReset();
  vi.stubEnv("AGENT_TOKEN", "test-agent");
  vi.stubEnv("CODEX_AGENT_TOKEN", "");
  vi.stubEnv("CRON_SECRET", "test-cron");
});
afterEach(() => vi.unstubAllEnvs());
describe("read-only Jev usage diagnostics", () => {
  it("requires dedicated agent authentication before reading aggregates", async () => {
    const attempts: Record<string, string>[] = [{}, { "x-cron-secret": "test-cron" }, { "x-agent-token": "test-cron" }];
    for (const headers of attempts) {
      const response = await GET(new Request("https://stanley.test/api/agent/intelligence/usage?token=test-agent", { headers }));
      expect(response.status).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it("returns reported aggregates without caching and distinguishes a metrics outage", async () => {
    const request = new Request("https://stanley.test/api/agent/intelligence/usage", { headers: { "x-agent-token": "test-agent" } });
    read.mockResolvedValueOnce({ available: true, last1h: { totals: { estimatedUsd: .1 } } });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({ available: true, last1h: { totals: { estimatedUsd: .1 } } });
    read.mockResolvedValueOnce({ available: false });
    const missing = await GET(request);
    expect(missing.status).toBe(503);
    expect(await missing.json()).toEqual({ available: false });
  });
});
