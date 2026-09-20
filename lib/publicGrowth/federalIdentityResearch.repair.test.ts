import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ rpc: vi.fn(), detail: vi.fn(), tables: [] as string[], selected: null as any }));
vi.mock("@/lib/supabase/server", () => ({ serviceClient: () => ({
  rpc: (...args: any[]) => mock.rpc(...args),
  from(table: string) {
    mock.tables.push(table);
    if (["company_government_matches", "federal_identity_remediation_receipts"].includes(table)) throw new Error("capped client scans must not return");
    const result = { error: null, data: table === "government_entities" ? { id: "entity", uei: "ABCDEFGHIJKL", usaspending_recipient_id: "recipient" }
      : table === "federal_awards" ? null : [] };
    const q = { select: () => q, eq: () => q, order: () => q, limit: () => q, single: async () => result, maybeSingle: async () => result,
      then: (resolve: any) => Promise.resolve(result).then(resolve) }; return q;
  },
}) }));
vi.mock("./usaspending", async () => ({ ...await vi.importActual("./usaspending"), fetchAwardDetail: (...args: any[]) => mock.detail(...args) }));
import { remediateOne } from "./federalIdentityResearch";
beforeEach(() => {
  vi.clearAllMocks(); mock.tables=[];
  mock.selected={ id:"match-401",company_id:"company",government_entity_id:"entity",match_status:"verified",match_method:"name_only",evidence:{ old:"preserved" } };
  mock.rpc.mockImplementation(async (name: string) => ({ error: null, data: name === "federal_identity_next_repair_match"
    ? { match:mock.selected,pending:true,hasWeakMatches:true } : { outcome:"needs_evidence",receiptId:"receipt" } }));
});
it("uses the exact uncapped server selection and existing before-image repair with the shared lease", async () => {
  expect(await remediateOne({ id:"company",name:"Acme",domain:null },"lease",Date.now()+30000)).toEqual({ outcome:"needs_evidence",receiptId:"receipt",matchId:"match-401",pending:true });
  expect(mock.rpc).toHaveBeenNthCalledWith(1,"federal_identity_next_repair_match",{p_company:"company",p_lease:"lease"});
  expect(mock.rpc).toHaveBeenNthCalledWith(2,"federal_identity_repair_match",expect.objectContaining({p_company:"company",p_lease:"lease",p_match:"match-401",p_before:mock.selected,p_outcome:"needs_evidence"}));
  expect(mock.detail).not.toHaveBeenCalled();
});
it("stops at the server's receipted work boundary without loading entities or rewriting matches", async () => {
  mock.rpc.mockResolvedValue({error:null,data:{match:null,pending:false,hasWeakMatches:true}});
  expect(await remediateOne({id:"company",name:"Acme",domain:null},"lease",Date.now()+30000)).toEqual({status:"awaiting_new_evidence",pending:false});
  expect(mock.tables).toEqual([]); expect(mock.rpc).toHaveBeenCalledOnce();
});
it("fails before any provider or repair when the selection lease is gone", async () => {
  mock.rpc.mockResolvedValue({error:{message:"identity lease lost"},data:null});
  await expect(remediateOne({id:"company",name:"Acme",domain:null},"lease",Date.now()+30000)).rejects.toThrow();
  expect(mock.tables).toEqual([]);expect(mock.rpc).toHaveBeenCalledOnce();expect(mock.detail).not.toHaveBeenCalled();
});
it("keeps the last candidate pending when an external edit wins the before-image CAS", async () => {
  mock.rpc.mockImplementation(async (name: string) => ({error:null,data:name === "federal_identity_next_repair_match"
    ? {match:mock.selected,pending:false,hasWeakMatches:true} : {outcome:"stale"}}));
  expect(await remediateOne({id:"company",name:"Acme",domain:null},"lease",Date.now()+30000)).toMatchObject({outcome:"stale",pending:true});
});
