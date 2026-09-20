import type { EvidenceAttributes } from "./evaluation";
export type VisibilityPolicy = { companyRelevance:number; concreteEvent:number; acquirerProbability:number; topicProbability:number; eventMaxAgeDays:number };
export const DEFAULT_VISIBILITY_POLICY:Readonly<VisibilityPolicy> = Object.freeze({companyRelevance:.8,concreteEvent:.75,acquirerProbability:.8,topicProbability:.8,eventMaxAgeDays:180});
/** Exploration changes this read-only view, never stored native answers or feed publication. */
export const EXPLORATORY_VISIBILITY_POLICY:Readonly<VisibilityPolicy> = Object.freeze({...DEFAULT_VISIBILITY_POLICY,companyRelevance:.5,concreteEvent:.5,acquirerProbability:.5,topicProbability:.5});
export type VisibilityFinding = { attributes:EvidenceAttributes; criteria:Record<string,number>; questionVersion:string };
export type VisibilityMode = "supported"|"explore";
export const visibilityPolicy = (mode:VisibilityMode) => mode === "explore" ? EXPLORATORY_VISIBILITY_POLICY : DEFAULT_VISIBILITY_POLICY;
/** Existing feed-routing rules; these do not alter Jev output or add a second opinion. */
export function jevPublicationRoute(result: VisibilityFinding, eventDate: string | null, now = Date.now(), policy: VisibilityPolicy = DEFAULT_VISIBILITY_POLICY): { type: string | null; reason: string } {
  const a = result.attributes;
  const classified = ["stanley-business-services-v2", "stanley-business-services-v3", "stanley-business-services-v4"].includes(result.questionVersion);
  if (classified) {
    // These are Jev's choices from the original evidence request, not another
    // interpretation or a headline/keyword filter. Old paid contracts are unchanged.
    if (a.contentClass !== "actual_company_development") return { type: null, reason: `content_${a.contentClass ?? "unknown"}` };
    if (!["subject", "service_provider", "customer", "partner"].includes(a.companyRole ?? "unknown"))
      return { type: null, reason: `company_role_${a.companyRole ?? "unknown"}` };
    if (a.operatingChangeType === "contract_award" && !["commercial_award", "government_award"].includes(a.contractActivity ?? ""))
      return { type: null, reason: "contract_award_not_established" };
  }
  const allowed = new Set(["funding", "ma", "new_entity", "finance_hire", "press", "operating_change", "erp_tech", "hiring_velocity", "employee_growth", "government_announcement"]);
  const relevantChange = ["systems_project", "finance_leadership", "close_reporting", "financial_controls", "cash_working_capital", "investor_reporting", "project_financials", "unbilled_work"].some(id => (result.criteria[id] ?? 0) >= policy.topicProbability);
  // Keep Jev's news label intact; this only selects an existing worklist category.
  const type = classified && a.contractActivity === "government_award" ? "government_announcement"
    : a.signalType === "news" && (relevantChange || (classified && a.contractActivity === "commercial_award")) ? "operating_change" : a.signalType;
  if (!allowed.has(type)) return { type: null, reason: "operating_context_only" };
  if (a.companyRelationship !== "direct") return { type: null, reason: "not_direct_company" };
  if (a.companyRelevance < policy.companyRelevance) return { type: null, reason: "company_relevance" };
  if (a.concreteEvent < policy.concreteEvent) return { type: null, reason: "no_concrete_development" };
  if (a.signalType === "ma" && a.isAcquirer < policy.acquirerProbability) return { type: null, reason: "not_acquirer" };
  const age = eventDate ? now - Date.parse(eventDate) : NaN;
  if (!Number.isFinite(age)) return { type: null, reason: "unknown_event_date" };
  if (age < 0) return { type: null, reason: "future_event_date" };
  if (age > policy.eventMaxAgeDays * 86_400_000) return { type: null, reason: "historical_event" };
  return { type, reason: "dated_development" };
}

export function visibilityReasonLabel(reason:string):string {
 const labels:Record<string,string>={dated_development:"Eligible dated development",operating_context_only:"Operating context, without a routed event category",not_direct_company:"Jev did not identify the company as the direct subject",
  company_relevance:"Company relevance below 80%",no_concrete_development:"Concrete development below 75%",not_acquirer:"Acquirer probability below 80%",unknown_event_date:"Event date unknown",future_event_date:"Event date is in the future",historical_event:"Event is more than 180 days old",
  no_selected_source_passage:"No selected source passage",structured_award_context:"Structured award uses its source-owned publisher",source_or_company_policy:"Existing company/source publication policy",contract_award_not_established:"Jev did not classify this as an awarded contract",superseded:"Evidence is superseded"};
 if(labels[reason])return labels[reason];
 if(reason.startsWith('content_'))return `Jev content classification: ${reason.slice(8).replace(/_/g,' ')}`;
 if(reason.startsWith('company_role_'))return `Jev company role: ${reason.slice(13).replace(/_/g,' ')}`;
 return reason.replace(/_/g,' ');
}
export type VisibilityObservation={id:string;companyId:string;companyName:string;title:string;url:string;eventDate:string|null;
 packets:(VisibilityFinding & {publication?:{status?:string;reason?:string}})[]};
export function summarizeVisibility(observations:VisibilityObservation[],now=Date.now()){
 const reasons:Record<string,number>={};const recordedPublication:Record<string,number>={};let packets=0;let eligible=0;let broader=0;
 const newCases:{observationId:string;companyId:string;companyName:string;title:string;url:string;reason:string;scores:Record<string,number>}[]=[];
 const values:{companyRelevance:number[];concreteEvent:number[]}={companyRelevance:[],concreteEvent:[]};
 for(const observation of observations)for(const packet of observation.packets){
  if(!packet?.attributes||typeof packet.questionVersion!=='string')continue;
  packets++;const current=jevPublicationRoute(packet,observation.eventDate,now);const exploration=jevPublicationRoute(packet,observation.eventDate,now,EXPLORATORY_VISIBILITY_POLICY);
  if(packet.publication?.status){const key=packet.publication.reason??packet.publication.status;recordedPublication[key]=(recordedPublication[key]??0)+1;}
  reasons[current.reason]=(reasons[current.reason]??0)+1;if(current.type)eligible++;if(exploration.type)broader++;
  for(const key of ['companyRelevance','concreteEvent'] as const){const n=packet.attributes[key];if(typeof n==='number'&&Number.isFinite(n))values[key].push(n);}
  if(!current.type&&exploration.type&&newCases.length<12)newCases.push({observationId:observation.id,companyId:observation.companyId,companyName:observation.companyName,title:observation.title,url:observation.url,
   reason:current.reason,scores:{companyRelevance:packet.attributes.companyRelevance,concreteEvent:packet.attributes.concreteEvent,isAcquirer:packet.attributes.isAcquirer}});
 }
 const histogram=(numbers:number[])=>[{from:0,to:.5},{from:.5,to:.75},{from:.75,to:.8},{from:.8,to:1.000001}].map(({from,to})=>({from,to:Math.min(1,to),count:numbers.filter(n=>n>=from&&n<to).length}));
 return {observations:observations.length,packets,currentEligiblePackets:eligible,exploratoryEligiblePackets:broader,additionalExploratoryPackets:broader-eligible,reasons,recordedPublication,
  nativeScoreDistribution:{companyRelevance:histogram(values.companyRelevance),concreteEvent:histogram(values.concreteEvent)},examples:newCases,
  defaultPolicy:DEFAULT_VISIBILITY_POLICY,explorationPolicy:EXPLORATORY_VISIBILITY_POLICY,
  calibration:{status:'not_calibrated',basis:'Saved native outputs only. These counts measure semantic/date routing sensitivity, not precision, recall or factual accuracy. Passage availability, source/company rules and deduplication are separate publication steps; recorded publication outcomes are reported separately. No second model was used; publication defaults are unchanged.'}};
}
