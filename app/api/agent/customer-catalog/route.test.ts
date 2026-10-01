import { beforeEach,describe,it,expect,vi } from "vitest";
vi.mock("@/lib/agent/auth",()=>({agentAuthOk:vi.fn(),unauthorized:()=>new Response("unauthorized",{status:401})}));
vi.mock("@/lib/supabase/server",()=>({withServiceDeadline:(_at:number,fn:()=>unknown)=>fn()}));
vi.mock("@/lib/intelligence/customerResearchServer",()=>({CustomerResearchError:class extends Error{},getApprovedCustomerCatalogStatus:vi.fn(),registerApprovedCustomerCatalog:vi.fn(),selectApprovedCustomerCatalog:vi.fn()}));
import {agentAuthOk} from "@/lib/agent/auth";
import {getApprovedCustomerCatalogStatus,registerApprovedCustomerCatalog,selectApprovedCustomerCatalog} from "@/lib/intelligence/customerResearchServer";
import {GET,POST} from "./route";
const request=(body:unknown)=>new Request("https://example.com/api/agent/customer-catalog",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
beforeEach(()=>{vi.clearAllMocks();vi.mocked(agentAuthOk).mockReturnValue(true);});
describe("catalog publication boundary",()=>{
  const version="customer-catalog-v1-"+"a".repeat(64);
  it("authenticates readback and rejects every write-shaped or ambiguous query",async()=>{
    vi.mocked(agentAuthOk).mockReturnValue(false);
    expect((await GET(request(null))).status).toBe(401);
    expect(getApprovedCustomerCatalogStatus).not.toHaveBeenCalled();
    vi.mocked(agentAuthOk).mockReturnValue(true);
    for(const suffix of ["?version=", "?action=select", "?version=wrong", `?version=${version}&version=${version}`, "?enablePaid=true"])
      expect((await GET(new Request("https://example.com/api/agent/customer-catalog"+suffix))).status).toBe(400);
    expect(getApprovedCustomerCatalogStatus).not.toHaveBeenCalled();
  });
  it("returns no-store exact-version and selected-version status without a write",async()=>{
    const status={registered:false,selectedVersion:null,paidEnabled:false,providerCalls:0,readOnly:true};
    vi.mocked(getApprovedCustomerCatalogStatus).mockResolvedValue(status as Awaited<ReturnType<typeof getApprovedCustomerCatalogStatus>>);
    const response=await GET(new Request(`https://example.com/api/agent/customer-catalog?version=${version}`));
    expect(response.status).toBe(200);expect(response.headers.get("Cache-Control")).toBe("no-store");expect(await response.json()).toEqual(status);
    expect(getApprovedCustomerCatalogStatus).toHaveBeenLastCalledWith(version);
    await GET(new Request("https://example.com/api/agent/customer-catalog"));
    expect(getApprovedCustomerCatalogStatus).toHaveBeenLastCalledWith(undefined);
    expect(registerApprovedCustomerCatalog).not.toHaveBeenCalled();expect(selectApprovedCustomerCatalog).not.toHaveBeenCalled();
  });
  it("requires agent authentication",async()=>{vi.mocked(agentAuthOk).mockReturnValue(false);expect((await POST(request({action:"select",version:"v1"}))).status).toBe(401);expect(selectApprovedCustomerCatalog).not.toHaveBeenCalled();});
  it("separates registering from selection and rejects paid activation fields",async()=>{
    vi.mocked(registerApprovedCustomerCatalog).mockResolvedValue({version:"v1",criteria:112,registered:true,selected:false,providerCalls:0});
    expect((await POST(request({action:"register",dictionary:{version:"v1"}}))).status).toBe(200);
    expect(registerApprovedCustomerCatalog).toHaveBeenCalledWith({version:"v1"});expect(selectApprovedCustomerCatalog).not.toHaveBeenCalled();
    expect((await POST(request({action:"select",version:"v1",enablePaid:true}))).status).toBe(400);
    expect(selectApprovedCustomerCatalog).not.toHaveBeenCalled();
  });
});
