import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const gate = vi.hoisted(() => ({ getTamDispatchGate: vi.fn(), setTamDispatchGate: vi.fn() }));
const coordination = vi.hoisted(() => ({ listTamRegradeRecords: vi.fn(), getTamRegradeStatus: vi.fn(), getTamPublishedEvent: vi.fn(), claimTamGradeWork: vi.fn(), heartbeatTamActor: vi.fn(), setTamGradeWorkStatus: vi.fn(), publishValidatedTamGrade: vi.fn() }));
vi.mock("@/lib/db/tamCoordination", () => coordination);
vi.mock("@/lib/db/tamDispatchGate", async importOriginal => ({ ...await importOriginal<object>(), ...gate }));
import { GET, POST } from "./route";
import { POST as publish } from "../tam-grade/route";
const base="https://stanley.local/api/cron/tam-coordination";
const headers={"x-agent-token":"test-agent"};
const pending="?view=records&run=active-run&current=true&pdf=verified&grade=pending";
const seed="11111111-1111-4111-8111-111111111111",op="22222222-2222-4222-8222-222222222222";
const state={runId:op,runSlug:"active-run",seedId:seed,paused:true,revision:1,operationId:op,updatedAt:"2026-09-20T12:00:00Z"};
const request=(query:string,auth=headers)=>new NextRequest(base+query,{headers:auth});
const post=(body:unknown,auth=headers)=>new NextRequest(base,{method:"POST",headers:auth,body:JSON.stringify(body)});
beforeEach(()=>{vi.stubEnv("AGENT_TOKEN","test-agent");vi.stubEnv("CODEX_AGENT_TOKEN","");vi.stubEnv("CRON_SECRET","cron-only");vi.clearAllMocks();gate.getTamDispatchGate.mockResolvedValue(state);gate.setTamDispatchGate.mockResolvedValue({gate:state});coordination.listTamRegradeRecords.mockResolvedValue({records:[{netsuite_internal_id:"123"}],total:1});coordination.getTamRegradeStatus.mockResolvedValue({counts:{pending:1}});coordination.claimTamGradeWork.mockResolvedValue({});coordination.heartbeatTamActor.mockResolvedValue({});coordination.setTamGradeWorkStatus.mockResolvedValue({});});
afterEach(()=>vi.unstubAllEnvs());
it("returns an explicit 409 for only the paused pending-admission selector",async()=>{
 const response=await GET(request(pending));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"tam_dispatch_paused",gate:state});expect(coordination.listTamRegradeRecords).not.toHaveBeenCalled();
});
it("returns actual pending records when the default-off gate is open",async()=>{
 gate.getTamDispatchGate.mockResolvedValue({...state,paused:false,revision:0,operationId:null});const response=await GET(request(pending));expect(response.status).toBe(200);expect(await response.json()).toMatchObject({total:1});expect(coordination.listTamRegradeRecords).toHaveBeenCalledTimes(1);
});
it.each([pending+"&id=123",pending.replace("grade=pending","grade=reading"),pending.replace("current=true","current=false"),pending.replace("pdf=verified","pdf=missing"),"?view=records&run=active-run","?run=active-run"])("does not gate exact or non-admission reads: %s",async query=>{
 expect((await GET(request(query))).status).toBe(200);expect(gate.getTamDispatchGate).not.toHaveBeenCalled();
});
it("keeps claims, heartbeat and work-status writes available for admitted work",async()=>{
 const common={runSlug:"active-run",actorKey:"reader",netsuiteInternalId:"123",claimToken:op};
 for(const body of [{action:"claim",...common},{action:"heartbeat",...common,status:"working"},{action:"grade_status",...common,status:"hold",holdReason:"Source detail requires review"}]) expect((await POST(post(body))).status).toBe(200);
 expect(coordination.claimTamGradeWork).toHaveBeenCalledTimes(1);expect(coordination.heartbeatTamActor).toHaveBeenCalledTimes(1);expect(coordination.setTamGradeWorkStatus).toHaveBeenCalledTimes(1);expect(gate.getTamDispatchGate).not.toHaveBeenCalled();
});
it("leaves validated publication available while admission is paused",async()=>{
 const h="a".repeat(64),time="2026-09-20T12:00:00Z",validation={status:"passed",validated_by:"independent-validator",validated_at:time};
 const data={schema:"tam-grade-provenance",version:1,runSlug:"active-run",netsuiteInternalId:"123",snapshotSha256:h,method:"full-record-reader-plus-independent-full-record-validator",pdfSha256:h,pdfPageCount:1,recordTextSha256:h,candidateFileSha256:h,validatorOutputSha256:h,validatorHashScope:"canonical-record",assessment:{exact_id:"123",final_score:38,record_digest:"Complete validated chronology",old_gold_score:0,old_gold_class:"no_revival",old_gold_reasons:[],intro_call_exists:false,opportunity_exists:false,revisit_on:null,dq_reason:"",validation}};
 const canonicalJson=JSON.stringify(data);coordination.publishValidatedTamGrade.mockResolvedValue({published:true});
 const response=await publish(post({runSlug:"active-run",netsuiteInternalId:"123",actorKey:"reader",claimToken:op,finalScore:38,recordDigest:"Complete validated chronology",provenance:{sha256:createHash("sha256").update(canonicalJson).digest("hex"),objectPath:"validated/123.json",canonicalJson,data},validation:{status:"passed",validatedBy:"independent-validator",validatedAt:time}}));
 expect(response.status).toBe(200);expect(coordination.publishValidatedTamGrade).toHaveBeenCalledTimes(1);expect(gate.getTamDispatchGate).not.toHaveBeenCalled();
});
it("exposes read-only status and authenticated state transitions",async()=>{
 expect((await GET(request(`?view=dispatch_gate&run=active-run&seed=${seed}`))).status).toBe(200);expect(gate.getTamDispatchGate).toHaveBeenCalledWith({runSlug:"active-run",seedId:seed});
 const body={action:"dispatch_gate_set",runSlug:"active-run",seedId:seed,operationId:op,expectedRevision:0,expectedPaused:false,paused:true,actorKey:"codex"};
 expect((await POST(post(body))).status).toBe(200);expect(gate.setTamDispatchGate).toHaveBeenCalledWith(body);
 expect((await POST(post(body,{"x-agent-token":"cron-only"}))).status).toBe(401);expect(gate.setTamDispatchGate).toHaveBeenCalledTimes(1);
});
it("propagates a gate read failure without disguising it as an empty queue",async()=>{
 gate.getTamDispatchGate.mockRejectedValue(new Error("database unavailable"));const response=await GET(request(pending));expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"database unavailable"});expect(coordination.listTamRegradeRecords).not.toHaveBeenCalled();
});
