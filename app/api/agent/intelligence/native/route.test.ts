import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), enabled: vi.fn(), privacy: vi.fn(), cached: vi.fn(), evaluate: vi.fn(), reserve: vi.fn(), settle: vi.fn() }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: mocks.auth, unauthorized: () => Response.json({error:"unauthorized"},{status:401}) }));
vi.mock("@/lib/intelligence/observations", () => ({ intelligenceEnabled: mocks.enabled }));
vi.mock("@/lib/intelligence/jev", () => ({ hasPrivateExcerptAuthorization: mocks.privacy, JEV_MODEL:"jev-test" }));
vi.mock("@/lib/intelligence/nativeJev", () => ({ evaluateNativeCached:mocks.cached,evaluateNativeQuestions:mocks.evaluate,nativeJevBody:vi.fn() }));
vi.mock("@/lib/intelligence/budget", () => ({reserveJev:mocks.reserve,settleJev:mocks.settle}));
import { GET, POST } from "./route";
const answer = {ok:true,provider_result:{model:"jev-test",answers:{work:{type:"choice",choice:"staffing",confidence:.821}}},usage:{inputTokens:1200,outputTokens:2}};
const request = (privacy:string) => new Request("http://localhost/api/agent/intelligence/native",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({state:{text:"Staffing engagement"},questions:{work:{type:"choice",instructions:"Choose work type",criteria:{staffing:"Staffing",other:"Other"}}},privacy})});
describe("Codex native Jev endpoint",()=>{
 beforeEach(()=>{vi.clearAllMocks();mocks.auth.mockReturnValue(true);mocks.enabled.mockReturnValue(true);mocks.privacy.mockReturnValue(true);mocks.reserve.mockResolvedValue("reservation");mocks.settle.mockResolvedValue(true);mocks.evaluate.mockResolvedValue(answer);mocks.cached.mockResolvedValue({status:"complete",evaluation:answer,reused:true});});
 it("requires the dedicated agent authorization and does not spend on readiness",async()=>{
  mocks.auth.mockReturnValue(false);expect((await POST(request("public"))).status).toBe(401);expect(mocks.cached).not.toHaveBeenCalled();
  mocks.auth.mockReturnValue(true);expect((await GET(new Request("http://localhost"))).status).toBe(200);expect(mocks.evaluate).not.toHaveBeenCalled();expect(mocks.reserve).not.toHaveBeenCalled();
 });
 it("returns the original public native receipt with connector attribution",async()=>{
  const result=await POST(request("public"));expect(await result.json()).toEqual({status:"complete",evaluation:answer,reused:true});
  expect(mocks.cached.mock.calls[0][1]).toMatchObject({purpose:"codex_connector",sourceKind:"codex_public",workload:"manual"});expect(mocks.evaluate).not.toHaveBeenCalled();
 });
 it("never caches private snippets and retains a paid answer if accounting fails",async()=>{
  mocks.settle.mockRejectedValue(new Error("temporary database failure"));const result=await POST(request("private_excerpt"));
  expect(await result.json()).toEqual({status:"complete",evaluation:answer,reused:false,accountingPending:true});expect(mocks.cached).not.toHaveBeenCalled();expect(mocks.settle).toHaveBeenCalledWith("reservation",1200);
 });
 it("defers before the paid request when privacy or budget is unavailable",async()=>{
  mocks.privacy.mockReturnValue(false);expect((await POST(request("private_excerpt"))).status).toBe(409);expect(mocks.reserve).not.toHaveBeenCalled();
  mocks.privacy.mockReturnValue(true);mocks.reserve.mockResolvedValue(null);expect((await POST(request("private_excerpt"))).status).toBe(429);expect(mocks.evaluate).not.toHaveBeenCalled();
  expect((await POST(request("unknown"))).status).toBe(400);
 });
});
