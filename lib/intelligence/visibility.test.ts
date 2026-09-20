import {describe,expect,it} from 'vitest';
import {DEFAULT_VISIBILITY_POLICY,EXPLORATORY_VISIBILITY_POLICY,jevPublicationRoute,summarizeVisibility,type VisibilityFinding} from './visibility';
const now=Date.parse('2026-09-19T12:00:00Z');
const finding=(patch:Record<string,unknown>={}):VisibilityFinding=>({questionVersion:'stanley-business-services-v3',criteria:{systems_project:.7},attributes:{signalType:'erp_tech',companyRelationship:'direct',contentClass:'actual_company_development',companyRole:'subject',contractActivity:'none',operatingChangeType:'systems_change',evidenceSectionId:'s1',companyRelevance:.7,concreteEvent:.7,isAcquirer:.1,operationalComplexity:.7,growthRelevance:.7,evidenceStrength:.8,requiresResearch:.7,...patch} as VisibilityFinding['attributes']});
describe('native visibility policy',()=>{
 it('keeps v4 classifications and routing identical to v3 including editorial exclusion',()=>{
  for(const patch of [{companyRelevance:.95,concreteEvent:.9},{companyRelevance:.95,concreteEvent:.9,contentClass:'editorial_coverage'}]){
   const old=finding(patch);
   expect(jevPublicationRoute({...old,questionVersion:'stanley-business-services-v4'},'2026-09-18',now)).toEqual(jevPublicationRoute(old,'2026-09-18',now));
  }
 });
 it('preserves feed defaults while explicitly comparing a broader read-only policy',()=>{
  const value=finding();const saved=structuredClone(value);
  expect(DEFAULT_VISIBILITY_POLICY).toEqual({companyRelevance:.8,concreteEvent:.75,acquirerProbability:.8,topicProbability:.8,eventMaxAgeDays:180});
  expect(jevPublicationRoute(value,'2026-09-18',now).reason).toBe('company_relevance');
  expect(jevPublicationRoute(value,'2026-09-18',now,EXPLORATORY_VISIBILITY_POLICY).type).toBe('erp_tech');expect(value).toEqual(saved);
 });
 it('never relaxes native identity/classification or date semantics for exploration',()=>{
  for(const patch of [{companyRelationship:'related'},{contentClass:'editorial_coverage'},{companyRole:'publisher'}])expect(jevPublicationRoute(finding(patch),'2026-09-18',now,EXPLORATORY_VISIBILITY_POLICY).type).toBeNull();
  expect(jevPublicationRoute(finding(),null,now,EXPLORATORY_VISIBILITY_POLICY).reason).toBe('unknown_event_date');
 });
 it('reports measured routing sensitivity, not factual accuracy, using only saved native outputs',()=>{
  const observation={id:'source',companyId:'account',companyName:'Synthetic',title:'ERP program',url:'https://test.test',eventDate:'2026-09-18',packets:[finding(),finding({companyRelevance:.95,concreteEvent:.9})]};
  const result=summarizeVisibility([observation],now);
  expect(result).toMatchObject({packets:2,currentEligiblePackets:1,exploratoryEligiblePackets:2,additionalExploratoryPackets:1,calibration:{status:'not_calibrated'}});
  expect(result.examples[0].scores.companyRelevance).toBe(.7);expect(result.calibration.basis).toContain('not precision');
 });
});
