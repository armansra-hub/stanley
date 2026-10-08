import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ collect: vi.fn(), event: vi.fn() }));
vi.mock("@/lib/triggers/atsSweep", () => ({ sweepAts: mocks.collect }));
vi.mock("@/lib/triggers/websiteSweep", () => ({ sweepWebsites: mocks.collect }));
vi.mock("@/lib/triggers/sweep", () => ({ sweepBase: mocks.collect }));
vi.mock("@/lib/triggers/fmcsaSweep", () => ({ sweepFmcsaTam: mocks.collect }));
vi.mock("@/lib/triggers/coSosSweep", () => ({ sweepCoSos: mocks.collect }));
vi.mock("@/lib/db/events", () => ({ logEvent: mocks.event }));
import * as ats from "./ats/route";
import * as website from "./website/route";
import * as news from "./triggers/route";
import * as fmcsa from "./fmcsa/route";
import * as cosos from "./cosos/route";

const companyId = "00000000-0000-0000-0000-000000000001";
const runCutoff = "2026-01-01T00:00:00Z";
const query = `sourceOnly=1&companyIds=${companyId}&runCutoff=${runCutoff}`;
beforeEach(() => { vi.stubEnv("CRON_SECRET", "test-cron"); mocks.collect.mockReset().mockResolvedValue({ checked: 0 }); mocks.event.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
describe.each([["ats", ats, 120], ["website", website, 150], ["news", news, 50], ["fmcsa", fmcsa, 150], ["cosos", cosos, 200]] as const)("%s finite route", (_name, route, defaultLimit) => {
  const request = (params: string, authorized = true) => new NextRequest(`http://localhost/api/cron/test?${params}`, { headers: authorized ? { "x-cron-secret": "test-cron" } : {} });
  it("authenticates before interpreting the exact scope", async () => {
    expect((await route.GET(request(query, false))).status).toBe(401);
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it.each(["offset=1", "scope=tail", "finance=1", "n=101", "sourceOnly=0"])("rejects conflicting %s without collector/event side effects", async bad => {
    const params = new URLSearchParams(query); const [key, value] = bad.split("="); params.set(key, value);
    expect((await route.POST(request(params.toString()))).status).toBe(400);
    expect(mocks.collect).not.toHaveBeenCalled(); expect(mocks.event).not.toHaveBeenCalled();
  });
  it("forwards the fixed paired scope and exact-set limit through GET and POST", async () => {
    for (const handler of [route.GET, route.POST]) expect((await handler(request(query))).status).toBe(200);
    expect(mocks.collect).toHaveBeenCalledTimes(2);
    expect(mocks.collect).toHaveBeenLastCalledWith(1, expect.objectContaining({ sourceOnly: true, offset: 0, collection: { companyIds: [companyId], runCutoff } }));
  });
  it("preserves default scheduled limits without an exact scope", async () => {
    expect((await route.GET(request(""))).status).toBe(200);
    expect(mocks.collect).toHaveBeenCalledWith(defaultLimit, expect.not.objectContaining({ collection: expect.anything() }));
  });
});
