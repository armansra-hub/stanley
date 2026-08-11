import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/agent/read select boundary", () => {
  const priorToken = process.env.AGENT_TOKEN;
  const priorBase = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const priorServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  beforeEach(() => {
    process.env.AGENT_TOKEN = "route-test-token";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "content-range": "0-0/0" },
    })));
  });

  afterEach(() => {
    if (priorToken === undefined) delete process.env.AGENT_TOKEN;
    else process.env.AGENT_TOKEN = priorToken;
    if (priorBase === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = priorBase;
    if (priorServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorServiceKey;
    vi.unstubAllGlobals();
  });

  const request = (query: string) => new Request(`https://stanley.test/api/agent/read?${query}`, {
    headers: { "x-agent-token": "route-test-token" },
  });

  it.each([
    "table=companies&select=name,tam_regrade_records(reader_claim_token)",
    "table=companies&select=seed:tam_regrade_records(reader_claim_token)",
    "table=companies&select=...tam_regrade_records(reader_claim_token)",
    "table=companies&select=name&select=tam_regrade_records(reader_claim_token)",
  ])("rejects unsafe or repeated selects before the upstream request: %s", async (query) => {
    const response = await GET(request(query));
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards only the validated scalar projection", async () => {
    const response = await GET(request("table=companies&select=name,tam_score&tam_score=gte.40&limit=25"));
    expect(response.status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
    const upstream = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(upstream.searchParams.get("select")).toBe("name,tam_score");
    expect(upstream.searchParams.get("tam_score")).toBe("gte.40");
  });

  it("replaces a star with the explicit scalar table contract", async () => {
    const response = await GET(request("table=companies&select=*"));
    expect(response.status).toBe(200);
    const upstream = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    const select = upstream.searchParams.get("select") ?? "";
    expect(select).toContain("netsuite_internal_id");
    expect(select).not.toContain("tam_regrade_records");
    expect(select).not.toContain("(");
  });
});
