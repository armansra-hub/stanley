import { beforeEach, afterEach, expect, it, vi } from "vitest";
const run = vi.hoisted(() => vi.fn());
const snapshot = vi.hoisted(() => vi.fn());
vi.mock("@/lib/publicGrowth/federalIdentityResearch", () => ({ runHistoricalFederalRemediation: run, historicalFederalRepairSnapshot: snapshot }));
import { GET, POST } from "./route";
beforeEach(() => { vi.stubEnv("AGENT_TOKEN", "agent-test"); vi.stubEnv("CODEX_AGENT_TOKEN", ""); run.mockReset().mockResolvedValue({ status: "complete", attempted: 20 }); });
afterEach(() => vi.unstubAllEnvs());
const req = (body: unknown, headers: Record<string,string> = { "x-agent-token": "agent-test" }) => new Request("https://local/api/agent/intelligence/federal-repair", { method: "POST", headers, body: JSON.stringify(body) });
it("rejects missing and cron-only credentials before claiming a lease", async () => {
  const cases: Record<string,string>[] = [{}, { "x-cron-secret": "agent-test" }];
  for (const headers of cases) expect((await POST(req({}, headers))).status).toBe(401);
  expect(run).not.toHaveBeenCalled();
});
it("accepts a bounded agent-authenticated run and rejects invalid limits", async () => {
  expect((await POST(req({ limit: 20 }))).status).toBe(200); expect(run).toHaveBeenCalledWith(20);
  for (const limit of [0, 21, 1.5, "20"]) expect((await POST(req({ limit }))).status).toBe(400);
  expect(run).toHaveBeenCalledTimes(1);
});
it("returns a checkpointed failure without retrying", async () => { run.mockResolvedValue({ status: "failed", attempted: 1 }); expect((await POST(req({ limit: 1 }))).status).toBe(503); expect(run).toHaveBeenCalledOnce(); });
it("authenticates progress reads and never invokes repair during a snapshot", async () => {
  expect((await GET(new Request("https://local"))).status).toBe(401);
  snapshot.mockResolvedValue({ currentWeakTotal: 200, outstandingEligible: 190, leased: 2, awaitingNewEvidence: 8 });
  expect((await GET(new Request("https://local?offset=200", { headers: { "x-agent-token": "agent-test" } }))).status).toBe(200);
  expect(snapshot).toHaveBeenCalledWith(200); expect(run).not.toHaveBeenCalled();
});
