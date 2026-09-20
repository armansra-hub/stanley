import {beforeEach,describe,it,expect,vi} from "vitest";
import {NextRequest} from "next/server";
const mocks=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock("@/lib/supabase/server",()=>({serviceClient:()=>mocks}));
import {GET,POST} from "./route";
const company="00000000-0000-0000-0000-000000000001",match="00000000-0000-0000-0000-000000000002";
const req=(body:unknown,origin="https://stanley.test")=>new NextRequest("https://stanley.test/api/headhunter/regional-contracts",{method:"POST",headers:{origin,"content-type":"application/json",cookie:"jarvis_auth=test-token"},body:JSON.stringify(body)});
beforeEach(()=>{vi.stubEnv("APP_PASSWORD","configured");vi.stubEnv("APP_SESSION_TOKEN","test-token");mocks.rpc.mockReset().mockResolvedValue({data:true,error:null});mocks.from.mockReset();});
describe("regional review API",()=>{
  it("requires authentication and same-origin writes",async()=>{
    expect((await GET(new NextRequest(`https://stanley.test/api/headhunter/regional-contracts?companyId=${company}`))).status).toBe(401);
    expect((await POST(req({companyId:company,matchId:match,status:"rejected"},"https://outside.test"))).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("requires a public supporting URL and note for manual confirmation",async()=>{
    expect((await POST(req({companyId:company,matchId:match,status:"verified",sourceUrl:"http://127.0.0.1/",note:"Account is this supplier"}))).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
    const r=await POST(req({companyId:company,matchId:match,status:"verified",sourceUrl:"https://example.com/contract",note:"Company identifies this exact source contract"}));expect(r.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("regional_contract_review",expect.objectContaining({p_company:company,p_match:match,p_status:"verified"}));
  });
  it("does not claim an absent or wrong-account match was saved",async()=>{
    mocks.rpc.mockResolvedValue({data:false,error:null});expect((await POST(req({companyId:company,matchId:match,status:"rejected"}))).status).toBe(404);
  });
});
