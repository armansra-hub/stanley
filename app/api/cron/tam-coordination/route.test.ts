import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({ getTamPublishedEvent: vi.fn(), getTamRegradeStatus: vi.fn(), listTamRegradeRecords: vi.fn() }));
const changes = vi.hoisted(() => ({ listTamEvidenceChanges: vi.fn(), admitTamEvidenceChanges: vi.fn() }));
vi.mock("@/lib/db/tamCoordination", () => mocks);
vi.mock("@/lib/db/tamEvidenceChanges", () => changes);
import { GET, POST } from "./route";
const base = "https://stanley.local/api/cron/tam-coordination";
const query = `?view=publish_event&run=test-run&id=123&provenanceSha256=${"a".repeat(64)}`;
function request(suffix = query, headers: Record<string,string> = { "x-agent-token": "dedicated-test-token" }) { return new NextRequest(base + suffix, { headers }); }
beforeEach(() => { vi.stubEnv("AGENT_TOKEN", "dedicated-test-token"); vi.stubEnv("CODEX_AGENT_TOKEN", ""); vi.stubEnv("CRON_SECRET", "cron-test-token"); vi.clearAllMocks(); mocks.getTamPublishedEvent.mockResolvedValue({ events: [] }); mocks.getTamRegradeStatus.mockResolvedValue({ counts: {} }); mocks.listTamRegradeRecords.mockResolvedValue({ records: [] }); });
afterEach(() => vi.unstubAllEnvs());
describe("TAM publication event GET", () => {
  const deniedHeaders: Record<string, string>[] = [{}, { "x-cron-secret": "cron-test-token" }, { authorization: "Bearer cron-test-token" }];
  it.each(deniedHeaders)("rejects unauthenticated or cron access", async (headers) => { expect((await GET(request(query, headers))).status).toBe(401); expect(mocks.getTamPublishedEvent).not.toHaveBeenCalled(); });
  it("accepts dedicated authentication and dispatches only the exact selectors", async () => {
    const response = await GET(request()); expect(response.status).toBe(200); expect(await response.json()).toEqual({ events: [] });
    expect(mocks.getTamPublishedEvent).toHaveBeenCalledWith({ runSlug: "test-run", netsuiteInternalId: "123", provenanceSha256: "a".repeat(64) });
    expect(mocks.getTamRegradeStatus).not.toHaveBeenCalled(); expect(mocks.listTamRegradeRecords).not.toHaveBeenCalled();
  });
  it("does not substitute a default run for missing exact selectors", async () => { await GET(request("?view=publish_event")); expect(mocks.getTamPublishedEvent).toHaveBeenCalledWith({ runSlug: null, netsuiteInternalId: null, provenanceSha256: null }); });
  it("keeps existing records and status GET dispatch", async () => { await GET(request("?view=records&run=test-run&id=123")); await GET(request("?run=test-run&events=5")); expect(mocks.listTamRegradeRecords).toHaveBeenCalledOnce(); expect(mocks.getTamRegradeStatus).toHaveBeenCalledWith("test-run", 5); expect(mocks.getTamPublishedEvent).not.toHaveBeenCalled(); });
  it("propagates a failed exact event read without a board fallback", async () => { mocks.getTamPublishedEvent.mockRejectedValue(new Error("timeout")); expect((await GET(request())).status).toBe(409); expect(mocks.getTamRegradeStatus).not.toHaveBeenCalled(); });
});
it("routes changed-evidence reads and bounded admission through the dedicated machine boundary", async () => {
  changes.listTamEvidenceChanges.mockResolvedValue({ changes: [] });
  expect((await GET(request("?view=evidence_changes&id=123&offset=100"))).status).toBe(200);
  expect(changes.listTamEvidenceChanges).toHaveBeenCalledWith("123", 100);
  const body = { action: "evidence_change_admit", runSlug: "successor" };
  changes.admitTamEvidenceChanges.mockResolvedValue({ admitted: 1 });
  const post = (headers: Record<string,string>) => new NextRequest(base, { method: "POST", headers, body: JSON.stringify(body) });
  expect((await POST(post({ "x-cron-secret": "cron-test-token" }))).status).toBe(401);
  expect(changes.admitTamEvidenceChanges).not.toHaveBeenCalled();
  expect((await POST(post({ "x-agent-token": "dedicated-test-token" }))).status).toBe(200);
  expect(changes.admitTamEvidenceChanges).toHaveBeenCalledWith(body);
});
