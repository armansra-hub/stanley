import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ enabled: vi.fn(), run: vi.fn(), progress: vi.fn(), auth: vi.fn(), import: vi.fn() }));
vi.mock("./observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("./customerReferenceResearch", () => ({ customerReferenceProgress: mocks.progress, runCustomerReferenceReading: mocks.run }));
vi.mock("@/lib/supabase/server", () => ({ withServiceDeadline: (_deadline: number, fn: () => unknown) => fn() }));
vi.mock("@/lib/db/events", () => ({ logEvent: vi.fn() }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: mocks.auth, unauthorized: () => new Response("unauthorized", { status: 401 }) }));
vi.mock("./customerReferenceRegistry", () => ({ normalizeCustomerReferenceImport: (body: Record<string, unknown>) => {
  if (!Array.isArray(body.records) || !body.records.length) throw new Error("invalid_registry_import"); return body.records;
}, importCustomerReferenceRegistry: mocks.import }));
import { GET, POST } from "@/app/api/agent/customer-references/route";
import { POST as IMPORT } from "@/app/api/agent/customer-references/import/route";
import { customerReferenceRunResponse } from "./customerReferenceHttp";
const request = (body = "{}") => new NextRequest("https://stanley.example.com/api/agent/customer-references", { method: "POST", body, headers: { "Content-Type": "application/json" } });
beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockReturnValue(true); mocks.enabled.mockReturnValue(true);
  mocks.run.mockResolvedValue({ processed: 1, completed: 1, stoppedBy: "deadline" });
  mocks.progress.mockResolvedValue({ total: 823, complete: 18, pending: 805 }); mocks.import.mockResolvedValue({ imported: 1 });
});
describe("shared foreground reference handlers", () => {
  it("requires the dedicated existing agent authorization for progress, work and import", async () => {
    mocks.auth.mockReturnValue(false);
    expect((await GET(new Request("https://stanley.example.com/api/agent/customer-references"))).status).toBe(401);
    expect((await POST(request())).status).toBe(401); expect((await IMPORT(request('{"records":[{}]}'))).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled(); expect(mocks.import).not.toHaveBeenCalled();
  });
  it("returns dynamic full-cohort progress without starting work", async () => {
    expect(await (await GET(new Request("https://stanley.example.com/api/agent/customer-references"))).json()).toMatchObject({ total: 823 });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it.each(['{}', '{"id":"force-one"}', '{"ignoreBudget":true}', '[]', 'null', 'not-json'])("retires paid customer reads before any claim for body %s", async body => {
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "customer_research_is_codex_owned" });
    expect(mocks.run).not.toHaveBeenCalled(); expect(mocks.progress).not.toHaveBeenCalled();
  });
  it("keeps the customer-owned research instruction even while paid work is paused", async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await customerReferenceRunResponse(request());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "customer_research_is_codex_owned" });
    expect(mocks.run).not.toHaveBeenCalled();
  });
  it("imports a bounded registry payload without starting website or model work", async () => {
    const response = await IMPORT(request('{"records":[{"id":"example"}]}'));
    expect(response.status).toBe(200); expect(mocks.import).toHaveBeenCalledTimes(1); expect(mocks.run).not.toHaveBeenCalled();
    expect((await IMPORT(request('{}'))).status).toBe(400);
  });
});
