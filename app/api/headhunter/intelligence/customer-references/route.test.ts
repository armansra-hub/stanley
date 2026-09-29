import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({ authorized: vi.fn(), enabled: vi.fn(), progress: vi.fn(), run: vi.fn(), event: vi.fn(), deadline: vi.fn() }));
vi.mock("@/lib/intelligence/http", async original => ({
  ...await original<typeof import("@/lib/intelligence/http")>(), intelligenceUiAuthorized: m.authorized,
}));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: m.enabled }));
vi.mock("@/lib/intelligence/customerReferenceResearch", () => ({ customerReferenceProgress: m.progress, runCustomerReferenceReading: m.run }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: m.deadline }));
vi.mock("@/lib/db/events", () => ({ logEvent: m.event }));

import { GET, POST } from "./route";

const url = "https://stanley.test/api/headhunter/intelligence/customer-references";
const saved = { asOf: "2026-09-28T23:00:00Z", total: 17, complete: 4, pending: 13, blocked: 0, running: 0, references: [] };
const run = { processed: 3, completed: 3, stoppedBy: "deadline" };
const get = () => GET(new NextRequest(url));
const post = (body = "{}", origin: string | null = "https://stanley.test") => POST(new NextRequest(url, {
  method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body,
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.authorized.mockReturnValue(true); m.enabled.mockReturnValue(true);
  m.progress.mockResolvedValue(saved); m.run.mockResolvedValue(run); m.event.mockResolvedValue(undefined);
  m.deadline.mockImplementation((_deadline: number, fn: () => unknown) => fn());
});

describe("customer reference research API", () => {
  it("authenticates both reads and paid requests before accessing reference state", async () => {
    m.authorized.mockReturnValue(false);
    expect((await get()).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(m.progress).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it.each([null, "https://other.test", "https://stanley.test.evil.test"])("rejects mutations with origin %s", async origin => {
    const response = await post("{}", origin);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "invalid_origin" });
    expect(m.run).not.toHaveBeenCalled();
    expect(m.progress).not.toHaveBeenCalled();
  });

  it("reads saved progress without dispatching research even when paid processing is disabled", async () => {
    m.enabled.mockReturnValue(false);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.deadline).toHaveBeenCalledWith(expect.any(Number), m.progress);
    expect(m.run).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it.each([true, false])("retires the old paid pipeline regardless of enabled state %s", async enabled => {
    m.enabled.mockReturnValue(enabled);
    const response = await post();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "customer_research_is_codex_owned" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.run).not.toHaveBeenCalled(); expect(m.progress).not.toHaveBeenCalled(); expect(m.event).not.toHaveBeenCalled();
  });

  it.each(['{"sources":["https://arbitrary.example"]}', '{"force":true}', "[]", "null", "not-json"])("never turns input %s into a new paid customer read", async body => {
    const response = await post(body);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "customer_research_is_codex_owned" });
    expect(m.run).not.toHaveBeenCalled(); expect(m.progress).not.toHaveBeenCalled();
  });

  it("keeps previously checkpointed source/native work readable after retirement", async () => {
    const partial = { ...saved, references: [{ id: "in-progress-customer", status: "pending", answered: 12,
      totalQuestions: 47, sourceStatus: "ready", sourcePages: 6 }] };
    m.progress.mockResolvedValue(partial);
    expect(await (await get()).json()).toEqual(partial);
    expect((await post()).status).toBe(409);
    expect(await (await get()).json()).toEqual(partial);
    expect(m.run).not.toHaveBeenCalled(); expect(m.event).not.toHaveBeenCalled();
  });
  it("returns a safe read failure without paid recovery or private diagnostics", async () => {
    m.progress.mockRejectedValue(new Error("private database message"));
    const response = await get();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "customer_references_unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(m.run).not.toHaveBeenCalled();
  });
});
