import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), budget: vi.fn(), enabled: vi.fn(), privacy: vi.fn(), cached: vi.fn(), evaluate: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: mocks.auth, unauthorized: () => Response.json({error:"unauthorized"},{status:401}) }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("@/lib/intelligence/jev", () => ({ hasPrivateExcerptAuthorization: mocks.privacy, JEV_MODEL:"jev-test" }));
vi.mock("@/lib/intelligence/nativeJev", () => ({ evaluateNativeCached:mocks.cached,evaluateNativeQuestions:mocks.evaluate,nativeJevBody:vi.fn() }));
vi.mock("@/lib/intelligence/budget", () => ({reserveJev:mocks.reserve,settleJev:mocks.settle,readJevBudgetPolicy:mocks.budget}));
import { GET, POST } from "./route";
const answer = {ok:true,provider_result:{model:"jev-test",answers:{work:{type:"choice",choice:"staffing",confidence:.821}}},usage:{inputTokens:1200,outputTokens:2}};
const request = (privacy:string) => new Request("http://localhost/api/agent/intelligence/native",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:{text:"Staffing engagement"},questions:{work:{type:"choice",instructions:"Choose work type",criteria:{staffing:"Staffing",other:"Other"}}},privacy})});
describe("Codex native Jev endpoint",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.budget.mockResolvedValue({available:true,enabled:false,blockedReason:"policy_disabled",phase:"initial"});mocks.auth.mockReturnValue(true);mocks.enabled.mockReturnValue(true);mocks.privacy.mockReturnValue(true);mocks.reserve.mockResolvedValue("reservation");mocks.settle.mockResolvedValue(true);mocks.evaluate.mockResolvedValue(answer);mocks.cached.mockResolvedValue({status:"complete",evaluation:answer,reused:true});});
 it("requires the dedicated agent authorization and does not spend on readiness",async()=>{
  mocks.auth.mockReturnValue(false);expect((await POST(request("public"))).status).toBe(401);expect(mocks.cached).not.toHaveBeenCalled();
  mocks.auth.mockReturnValue(true);expect((await GET(new Request("http://localhost"))).status).toBe(200);expect(mocks.evaluate).not.toHaveBeenCalled();expect(mocks.reserve).not.toHaveBeenCalled();
 });
 it("reports database pause and catalog version without a provider call",async()=>{
  const result=await GET(new Request("http://localhost"));const body=await result.json();
  expect(body.enabled).toBe(false);expect(body.budget).toMatchObject({available:true,enabled:false,blockedReason:"policy_disabled"});
  expect(body.catalog.facets).toBe(47);expect(body.catalog.industryGuides).toBe(35);expect(body.catalog.version).toMatch(/^ring-ring-v1-/);
  expect(mocks.evaluate).not.toHaveBeenCalled();expect(mocks.cached).not.toHaveBeenCalled();
  mocks.budget.mockResolvedValue({available:false});expect((await (await GET(new Request("http://localhost"))).json()).enabled).toBe(false);
 });
 it("returns the original public native receipt with connector attribution",async()=>{
  const result=await POST(request("public"));expect(await result.json()).toEqual({status:"complete",evaluation:answer,reused:true});
  expect(mocks.cached.mock.calls[0][1]).toMatchObject({purpose:"codex_connector",sourceKind:"codex_public",workload:"manual"});expect(mocks.evaluate).not.toHaveBeenCalled();
 });
 it("blocks all private evaluation before reservation or provider dispatch",async()=>{
  const result=await POST(request("private_excerpt"));
  expect(await result.json()).toEqual({error:"private_evaluation_excluded_from_jev_policy"});
  expect(result.status).toBe(409);expect(mocks.cached).not.toHaveBeenCalled();expect(mocks.reserve).not.toHaveBeenCalled();expect(mocks.evaluate).not.toHaveBeenCalled();
 });
 it("defers before the paid request when privacy or budget is unavailable",async()=>{
  mocks.privacy.mockReturnValue(false);expect((await POST(request("private_excerpt"))).status).toBe(409);expect(mocks.reserve).not.toHaveBeenCalled();
  mocks.cached.mockResolvedValue({status:"budget_deferred",reason:"daily_allowance_exhausted",retryAt:"2026-09-26T07:00:00Z"});
  const deferred=await POST(request("public"));expect(deferred.status).toBe(429);expect(await deferred.json()).toMatchObject({reason:"daily_allowance_exhausted",retryAt:"2026-09-26T07:00:00Z"});expect(mocks.evaluate).not.toHaveBeenCalled();
  expect((await POST(request("unknown"))).status).toBe(400);
 });
});
