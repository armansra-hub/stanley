import {describe,it,expect,vi} from "vitest";
vi.mock("@/lib/intelligence/observations",()=>({intelligenceEnabled:()=>true}));
vi.mock("@/lib/supabase/server",()=>({serviceClient:vi.fn()}));
import {runRegionalContracts,type RegionalStore} from "./collector";
import type {RegionalSourceId} from "./sources";
const account={id:"account",name:"Example Services",domain:"example.com"};
function store():RegionalStore {
  const seen=new Set<string>();
  return{accounts:async()=>[account],claim:vi.fn(async(id:RegionalSourceId)=>{if(seen.has(id))return null;seen.add(id);return{id,lease_token:id,next_offset:500,snapshot_version:"old",snapshot_complete:false};}),finish:vi.fn(async()=>{}),identityEvidence:vi.fn(async()=>[])};
}
describe("regional collection checkpoints",()=>{
  it("visits both sources and checkpoints failures without advancing or discarding successful matches",async()=>{
    const db=store();const fetchPage=vi.fn(async(id:RegionalSourceId)=>{if(id==="wa_fy2025_contracts")throw new Error("regional_source_unavailable");return{rows:[{source_row_id:"row1",prime_contractor:account.name,contract_no:"SFO-2026-00123"}],offset:501,version:"new",complete:false,unchanged:false};});
    const result=await runRegionalContracts({store:db,fetchPage});expect(result).toMatchObject({pages:1,scanned:1,candidates:1,failed:1});
    expect(fetchPage.mock.calls.map(call=>call[0])).toEqual(["sf_supplier_contracts","wa_fy2025_contracts"]);
    expect(vi.mocked(db.finish).mock.calls[1][1]).toMatchObject({offset:500,version:"old",scanned:0,candidates:[],error:"regional_source_unavailable"});
  });
  it("reuses retained first-party contract evidence without a model call",async()=>{
    const db=store();vi.mocked(db.identityEvidence!).mockResolvedValue([{id:"obs",company_id:account.id,source_url:"https://example.com/contracts",evidence_text:"Example Services performs San Francisco contract SFO-2026-00123."}]);
    const result=await runRegionalContracts({store:db,fetchPage:async(id)=>({rows:id==="sf_supplier_contracts"?[{source_row_id:"row1",prime_contractor:account.name,contract_no:"SFO-2026-00123"}]:[],offset:1,version:"new",complete:true,unchanged:false})});
    expect(result.confirmed).toBe(1);expect(vi.mocked(db.finish).mock.calls[0][1].candidates[0].identityEvidence?.observationId).toBe("obs");
  });
  it("retains name candidates if optional identity evidence lookup fails",async()=>{
    const db=store();vi.mocked(db.identityEvidence!).mockRejectedValue(new Error("temporarily unavailable"));
    const result=await runRegionalContracts({store:db,fetchPage:async()=>({rows:[{source_row_id:"row1",prime_contractor:account.name}],offset:1,version:"new",complete:true,unchanged:false})});
    expect(result).toMatchObject({failed:0,identityLookupFailed:1,candidates:1});
  });
});
