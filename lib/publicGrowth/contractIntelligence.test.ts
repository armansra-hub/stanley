import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/triggers", () => ({ recomputePriority: vi.fn() }));
import { contractMilestones, contractTimingSignalDate, contractObservation, exactAnnouncementAward, announcementLinkInput, type ContractAward } from "./contractIntelligence";
import { nativeJevBody } from "@/lib/intelligence/nativeJev";
import { triggerIsAfterReviewBoundary } from "@/lib/triggers/freshness";
const award: ContractAward = { id: "award1", generated_award_id: "CONT_A_123", government_entity_id: "recipient", award_id: "47QRAA26D0001",
 awarding_agency: "Agency", description: "Staffing and project delivery services", start_date: "2026-09-24", end_date: "2026-10-20", potential_end_date: "2027-10-20",
 award_ceiling: 2000000, current_award_amount: 250000, total_obligations: 80000, source_url: "https://www.usaspending.gov/award/CONT_A_123", payload_hash: "hash",
 evidence: { optionSchedule: "not_provided_by_source" } };
const now = Date.parse("2026-09-20T12:00:00Z");
describe("contract intelligence", () => {
 it("does not reheat a dismissal for a late-discovered historical window, but permits a later window", () => {
  const contract={...award,start_date:null,end_date:"2026-12-31",potential_end_date:null};
  const reviewedThrough="2026-09-19T19:28:11.920Z";
  const historical=contractMilestones(contract,now)[0];
  expect(historical.stage).toBe(180);expect(contractTimingSignalDate(historical)).toBe("2026-07-04");
  expect(triggerIsAfterReviewBoundary({signal_date:contractTimingSignalDate(historical),detected_at:"2026-09-20T08:36:53Z"},reviewedThrough)).toBe(false);
  const later=contractMilestones(contract,Date.parse("2026-10-02T12:00:00Z"))[0];
  expect(later.stage).toBe(90);expect(contractTimingSignalDate(later)).toBe("2026-10-02");
  expect(triggerIsAfterReviewBoundary({signal_date:contractTimingSignalDate(later),detected_at:"2026-10-02T12:00:00Z"},reviewedThrough)).toBe(true);
 });
 it("dates each threshold in UTC independently of first collection time", () => {
  for(const [stage,date] of [[180,"2026-07-04"],[90,"2026-10-02"],[30,"2026-12-01"],[7,"2026-12-24"]] as const)
   expect(contractTimingSignalDate({kind:"end",date:"2026-12-31",stage,label:"Performance ends"})).toBe(date);
 });
 it("keeps sourced option URLs and rejects impossible dates and nonpublic source links",()=>{
  const dates=contractMilestones({...award,start_date:"2026-09-31",end_date:null,evidence:{optionDates:[
    {date:"2026-10-20",sourceUrl:"https://agency.test/options"},{date:"2026-10-21",sourceUrl:"javascript:bad"}] }},now);
  expect(dates).toEqual([{kind:"option",date:"2026-10-20",stage:30,label:"Reported option window",sourceUrl:"https://agency.test/options"}]);
 });
 it("bounds six long multilingual official descriptions below the native request cap",()=>{
  const row={id:"t",summary:"Award announcement",source_url:"https://company.test/news",signal_date:"2026-09-01",metadata:{intelligenceEvidence:{excerpt:"𠜎".repeat(10000)}}};
  const candidates=Array.from({length:6},(_,i)=>({...award,id:`award${i}`,description:"𠜎".repeat(10000)}));
  expect(()=>nativeJevBody(announcementLinkInput("Synthetic",row,candidates))).not.toThrow();
 });
 it("uses known dates and exact stage boundaries without inventing option windows", () => {
   expect(contractMilestones(award, now)).toEqual([{ kind: "start", date: "2026-09-24", stage: 7, label: "Performance starts" },
    { kind: "end", date: "2026-10-20", stage: 30, label: "Current performance ends" }]);
   expect(contractMilestones({ ...award, start_date: "2026-09-19", end_date: null }, now)).toEqual([]);
   expect(contractMilestones({ ...award, end_date: "2026-10-20", potential_end_date: "2026-10-20" }, now).filter(m => m.kind === "potential_end")).toEqual([]);
 });
 it("preserves funding/ceiling distinctions and code context in the first-pass observation", () => {
   const result = contractObservation({ id: "company", name: "Acme", domain: "acme.test" }, { ...award, naics_code: "541330", psc_code: "R425" }, "Acme LLC");
   expect(result.metadata.structuredAward).toBe(true); expect(result.text).toContain('"obligationsCommitted": 80000');
   expect(result.text).toContain('"ceilingIncludingOptions": 2000000'); expect(result.text).toContain('"naics": "541330"');
   expect(result.text).toContain("neither is recognized revenue");
 });
 it("requires a full award identifier rather than a same-name or prefix mention", () => {
   const row = { id: "t", summary: "Acme wins award 47QRAA26D0001", source_url: "https://acme.test/news", signal_date: "2026-09-01", metadata: {} };
   expect(exactAnnouncementAward(row, award)).toBe(true);
   expect(exactAnnouncementAward({ ...row, summary: "Acme wins 47QRAA26D00010" }, award)).toBe(false);
   expect(exactAnnouncementAward({ ...row, summary: "Acme wins an award" }, award)).toBe(false);
   const request = announcementLinkInput("Acme", row, [award]);
   expect(Object.keys(request.questions)).toEqual(["award"]); expect(request.questions.award.instructions).toContain("Different orders under one vehicle");
 });
});
