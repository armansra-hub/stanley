import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), priority: vi.fn(), reheat: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/agent/auth", () => ({ agentAuthOk: (req: Request) => req.headers.get("authorization") === "Bearer synthetic-test-token",
  unauthorized: () => new Response("Unauthorized", { status: 401 }) }));
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: mocks.priority }));
vi.mock("@/lib/db/reheat", () => ({ reheatCompanyForFreshSignal: mocks.reheat }));
import { POST } from "./route";
const id="10000000-0000-4000-8000-000000000001";
const input={action:"reconcile_hold",jobId:id,requestId:"20000000-0000-4000-8000-000000000002",lease:"30000000-0000-4000-8000-000000000003",
  snapshotHash:"a".repeat(64),currentSnapshotHash:"b".repeat(64),taskId:"/root",reviewerTaskId:"/root/incident_reviewer",
  incidentId:"40000000-0000-4000-8000-000000000004",evidenceSha256:"e".repeat(64),reason:"An expired lease and changed immutable snapshot prevent the previously reviewed source from finishing. Preserve it as incomplete."};
function packet(){return {jobId:id,status:"queued",lease:null,leaseUntil:null,snapshotHash:input.currentSnapshotHash,
 review:{actor:"/root/reader",requestId:input.requestId,snapshotHash:input.snapshotHash,hold:input.reason,
  reconciliation:{request:{...input},currentSnapshot:{original:"preserved"},receipt:{jobId:id,incidentId:input.incidentId,eventId:"event-id",disposition:"incomplete_hold",
   originalSnapshotHash:input.snapshotHash,currentSnapshotHash:input.currentSnapshotHash,evidenceSha256:input.evidenceSha256,analysisCompleted:false,triggerId:null}}},
 snapshot:{observation:{id:"observation",company_id:"company",source_kind:"news",evidence_text:"Retained original",metadata:{}},company:{id:"company",name:"Acme",domain:"acme.test",subindustry:null},identity:{}}};}
const request=(body:unknown,auth=true)=>new Request("https://test/api/agent/intelligence/news",{method:"POST",headers:{authorization:auth?"Bearer synthetic-test-token":"invalid","x-agent-name":"codex"},body:JSON.stringify(body)});
beforeEach(()=>vi.clearAllMocks());
describe("explicit stale claim hold reconciliation",()=>{
 it("requires authentication before any database call",async()=>{expect((await POST(request(input,false))).status).toBe(401);expect(mocks.rpc).not.toHaveBeenCalled();});
 it.each([
  {reviewerTaskId:input.taskId},{currentSnapshotHash:input.snapshotHash},{evidenceSha256:"bad"},{incidentId:"bad"},
  {reason:"short"},{force:true},{trigger:{type:"press"}},
 ])("rejects invalid or broad recovery input %j",async(change)=>{expect((await POST(request({...input,...change}))).status).toBe(400);expect(mocks.rpc).not.toHaveBeenCalled();});
 it("dispatches the incident once, exact reads its held result, and never publishes or reheats",async()=>{
  mocks.rpc.mockResolvedValue({data:packet(),error:null});const response=await POST(request(input));expect(response.status).toBe(200);
  expect((await response.json()).job.review.reconciliation.receipt.analysisCompleted).toBe(false);
  expect(mocks.rpc.mock.calls.map(([,args])=>args.p_action)).toEqual(["reconcile_hold","status"]);
  expect(mocks.rpc.mock.calls[1][1].p_payload).toEqual({jobId:id,requestId:input.requestId});expect(mocks.priority).not.toHaveBeenCalled();expect(mocks.reheat).not.toHaveBeenCalled();
 });
 it("never retries an uncertain mutation",async()=>{mocks.rpc.mockResolvedValue({data:null,error:{code:"connection_lost"}});expect((await POST(request(input))).status).toBe(409);expect(mocks.rpc).toHaveBeenCalledTimes(1);});
 it.each(["changed_request","completed","active_lease","missing","wrong_hash","wrong_incident","trigger","analysis_complete"])("rejects unconfirmed exact readback: %s",async(kind)=>{
  const next:any=packet();if(kind==="changed_request")next.review.reconciliation.request.reason="Changed";
  if(kind==="completed")next.status="complete";if(kind==="active_lease")next.lease=input.lease;
  if(kind==="wrong_hash")next.review.reconciliation.receipt.currentSnapshotHash="c".repeat(64);
  if(kind==="wrong_incident")next.review.reconciliation.receipt.incidentId=id;
  if(kind==="trigger")next.review.reconciliation.receipt.triggerId=id;
  if(kind==="analysis_complete")next.review.reconciliation.receipt.analysisCompleted=true;
  mocks.rpc.mockResolvedValueOnce({data:packet(),error:null}).mockResolvedValueOnce({data:kind==="missing"?null:next,error:null});
  expect((await POST(request(input))).status).toBe(409);expect(mocks.rpc).toHaveBeenCalledTimes(2);expect(mocks.reheat).not.toHaveBeenCalled();
 });
});
