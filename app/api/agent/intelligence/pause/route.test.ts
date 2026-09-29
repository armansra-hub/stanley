import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), client: vi.fn(), from: vi.fn(), update: vi.fn(),
  eq: vi.fn(), select: vi.fn(), single: vi.fn() }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: mocks.auth,
  unauthorized: () => Response.json({ error: "unauthorized" }, { status: 401 }) }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: mocks.client }));

import { POST } from "./route";

const now = "2026-09-29T18:00:00.000Z";
const policy = { id: "jev-rollout-2026-09-24", enabled: false,
  halt_reason: "user_requested_customer_research_pause", updated_at: now };
const request = (body = '{"paused":true}', headers?: HeadersInit) =>
  new Request("http://localhost/api/agent/intelligence/pause", { method: "POST", body, headers });

describe("pause-only paid Jev control", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers(); vi.setSystemTime(new Date(now));
    mocks.auth.mockReturnValue(true);
    mocks.client.mockReturnValue({ from: mocks.from });
    mocks.from.mockReturnValue({ update: mocks.update });
    mocks.update.mockReturnValue({ eq: mocks.eq });
    mocks.eq.mockReturnValue({ select: mocks.select });
    mocks.select.mockReturnValue({ single: mocks.single });
    mocks.single.mockResolvedValue({ data: policy, error: null });
  });
  afterEach(() => vi.useRealTimers());

  it("authenticates before reading the body or touching storage", async () => {
    mocks.auth.mockReturnValue(false);
    const req = request();
    const body = vi.spyOn(req, "text");
    expect((await POST(req)).status).toBe(401);
    expect(body).not.toHaveBeenCalled();
    expect(req.bodyUsed).toBe(false);
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it.each(['{"paused":false}', '{"paused":true,"enabled":true}', '{"paused":"true"}', '{}', 'null', '[]', 'invalid',
    ' '.repeat(1_024) + '{"paused":true}'])("rejects invalid/oversized bodies without storage: %s", async body => {
    const response = await POST(request(body));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_pause_request" });
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("rejects oversized content length before reading the body", async () => {
    const req = request(undefined, { "content-length": "1025" });
    const body = vi.spyOn(req, "text");
    expect((await POST(req)).status).toBe(400);
    expect(body).not.toHaveBeenCalled();
    expect(mocks.client).not.toHaveBeenCalled();
  });

  it("updates only the fixed Jev policy and returns its exact saved state", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mocks.from).toHaveBeenCalledOnce();
    expect(mocks.from).toHaveBeenCalledWith("intelligence_jev_budget_policy");
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.update).toHaveBeenCalledWith({ enabled: false,
      halt_reason: policy.halt_reason, updated_at: now });
    expect(mocks.eq).toHaveBeenCalledOnce();
    expect(mocks.eq).toHaveBeenCalledWith("id", policy.id);
    expect(mocks.select).toHaveBeenCalledOnce();
    expect(mocks.select).toHaveBeenCalledWith("id,enabled,halt_reason,updated_at");
    expect(mocks.single).toHaveBeenCalledOnce();
    expect(await response.json()).toEqual({ paused: true, policy });
  });

  it.each([
    { data: null, error: null },
    { data: policy, error: { message: "database failure" } },
    { data: { ...policy, id: "other-policy" }, error: null },
    { data: { ...policy, enabled: true }, error: null },
    { data: { ...policy, halt_reason: null }, error: null },
    { data: { ...policy, updated_at: "2026-09-28T18:00:00.000Z" }, error: null },
  ])("fails closed on missing or unexpected write readback", async result => {
    mocks.single.mockResolvedValue(result);
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "jev_pause_unavailable" });
  });

  it("returns a bounded failure if storage throws", async () => {
    mocks.single.mockRejectedValue(new Error("private database details"));
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "jev_pause_unavailable" });
  });
});
