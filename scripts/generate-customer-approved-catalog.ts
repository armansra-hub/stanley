/** Offline deterministic projection. Run with vite-node and two explicit local
 * paths: research root, private output directory. Never writes into this repo. */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { createHash } from "node:crypto";
import { normalizeCustomerResearchProfile } from "../lib/intelligence/customerResearchProfiles";
import { providerIndustryContextDefinitions } from "../lib/intelligence/customerIndustryContext";
import { approvedCustomerCriterionVersion, approvedCustomerCatalogVersion, normalizeApprovedCustomerCatalog, projectCustomerBusinessScopeProof,
  customerProofHash, type ApprovedCustomerCriterion, type CustomerCriterionBinding } from "../lib/intelligence/customerApprovedCatalog";

const [researchArg, outputArg, bindingArg] = process.argv.slice(2);
if (!researchArg || !outputArg) throw new Error("usage: research-root private-output-dir [explicit-bindings.json]");
const research = resolve(researchArg), output = resolve(outputArg), repo = resolve(import.meta.dirname ?? process.cwd(), "..");
const inside = (root: string, path: string) => { const rel = relative(root,path); return !rel.startsWith("..") && !/^[A-Za-z]:/.test(rel); };
if (inside(repo,output) || output === research) throw new Error("output_must_be_private_outside_repository");
const sha = (body: string) => createHash("sha256").update(body).digest("hex");
function load(file: string) { const body = readFileSync(join(research,file),"utf8"); return { file, sha256:sha(body), value:JSON.parse(body) }; }
function save(file: string,value: unknown) { const body=JSON.stringify(value,null,2)+"\n"; writeFileSync(join(output,file),body); return {file,sha256:sha(body),bytes:Buffer.byteLength(body)}; }
const delivery = load("final-delivery/CUSTOMER-RESEARCH-PACKAGE.json");
const mapped = load("final-delivery/CUSTOMER-PATTERN-MAP-823.json");
const scopes = load("research-notes/customer-business-scope-rollup.json");
const receipt = load("final-delivery/DELIVERY-RECEIPT.json");
for(const input of [delivery,mapped]) {
  const named=receipt.value.outputs.find((x:{file:string})=>x.file===input.file.split("/").at(-1));
  if(!named||named.sha256!==input.sha256) throw new Error(`delivery_hash:${input.file}`);
}
const at = new Date().toISOString();
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value==="string" ? [value] : [];
const sharedRules = ["Classify only the named provider and offering at the stated time; do not inherit a client, partner, parent or subsidiary's activities.",
  "Require the entire predicate. Missing evidence remains unknown; repeated work does not establish repeated billing; asset operation does not establish legal ownership."];
const facets: ApprovedCustomerCriterion[] = delivery.value.proposals.map((p:any) => {
  const d=p.definition, owner=p.sourceFile.includes("inventory-")?"inventory":p.sourceFile.includes("paid-policy-")?"policy":p.sourceFile.includes("profiles-")?"profiles":"root";
  const predicate=d.definition??d.positiveCriteria;
  const exclusions=strings(d.exclusionCriteria??d.exclusion??d.exclusionsAndUnknowns);
  const scope=String(d.scope);
  const applicability = ["universal","cross-industry"].includes(scope) ? {scope:"universal" as const}
    : {scope:"industry" as const,industryIds:[scope.replace(/^sector:/,"").replace(/[^a-zA-Z0-9_.-]/g,"-").toLowerCase()]};
  const value: Omit<ApprovedCustomerCriterion,"definitionVersion"> = {
    id:`${owner}-${d.id}`,label:d.label,familyId:p.familyId,sourceProposalKey:p.key,originalScope:scope,applicability,
    predicate,evidenceRules:[...strings(d.inclusionCriteria??d.inclusion??d.positiveCriteria),...sharedRules],exclusions,
    positiveExamples:[{scenario:predicate,explanation:"Illustrative statement of the complete required mechanism; actual customer evidence is held in the private reference proofs."}],
    negativeExamples:[{scenario:exclusions.join(" "),explanation:"Boundary example. An exclusion or missing detail is not automatically an explicit negative finding; use the four-state evidence contract."}],
  };
  return {...value,definitionVersion:approvedCustomerCriterionVersion(value)};
});
const aliases=facets.map(f=>({sourceProposalKey:f.sourceProposalKey,criterionId:f.id}));
const candidate={schema:"customer-approved-catalog-v1",status:"approved",
  version:"customer-catalog-v1-"+customerProofHash(facets.map(f=>({id:f.id,definitionVersion:f.definitionVersion})).sort((a,b)=>a.id.localeCompare(b.id,"en"))),
  author:{kind:"codex",name:"Codex customer research",authoredAt:at},facets,
  navigationFamilies:delivery.value.families.map((f:any)=>({id:f.id,label:f.label,selectableCategory:false,facetIds:f.facetIds,organizingQuestion:f.organizingQuestion,nonMergeBoundaries:f.nonMergeBoundaries})),
  evidenceFields:delivery.value.facets,industryContextDefinitions:providerIndustryContextDefinitions(),proposalAliases:aliases,equivalentQuestions:[],
  sourceManifest:[delivery,mapped,scopes,receipt].map(({file,sha256})=>({file,sha256})),
  cohortProof:{cohortCount:823,accountedForCount:823,mappedRecords:659,unmappedRecords:164,sourceScopesReviewed:661,
    scopeComplete:208,scopeCompleteWithGaps:453,identityOrSourceGap:162,attributionHolds:2,
    sourceMapSha256:mapped.sha256,sourceScopeSha256:scopes.sha256,
    membershipMeaning:"Authored predicate bindings only; field observations are not category membership. Missing bindings are not yet evaluated."},
};
candidate.version=approvedCustomerCatalogVersion(candidate as any);
const catalog=normalizeApprovedCustomerCatalog(candidate);
mkdirSync(output,{recursive:true});
const outputs=[save("approved-catalog.json",catalog),save("criterion-aliases.json",{version:catalog.version,criteria:facets.map(f=>({id:f.id,definitionVersion:f.definitionVersion,sourceProposalKey:f.sourceProposalKey,originalScope:f.originalScope,predicate:f.predicate,evidenceRules:f.evidenceRules,exclusions:f.exclusions}))})];
// --catalog-only is useful before the independent author finishes additive bindings.
if(bindingArg==="--catalog-only") { console.log(JSON.stringify({catalogVersion:catalog.version,outputs})); process.exit(0); }
const bindingInput=bindingArg?JSON.parse(readFileSync(resolve(bindingArg),"utf8")):{bindings:[],reviews:[]};
const additive:CustomerCriterionBinding[] = bindingInput.bindings;
const reviews=new Map<string,any>((bindingInput.reviews??[]).map((r:any)=>[r.customerId,r]));
const rows=new Map<string,any>(mapped.value.rows.map((r:any)=>[r.customerId,r]));
const scopeRows=new Map<string,any>(scopes.value.items.map((r:any,i:number)=>[r.customerId,{...r,index:i}]));
if(rows.size!==823||scopeRows.size!==823||delivery.value.customers.length!==823) throw new Error("cohort_membership");
const bindingsByCustomer=new Map<string,CustomerCriterionBinding[]>();
for(const b of additive) {
  const criterion=facets.find(f=>f.id===b.criterionId);
  if(!criterion||criterion.definitionVersion!==b.definitionVersion||!rows.has(b.customerId)) throw new Error(`binding_catalog:${b.criterionId}`);
  const list=bindingsByCustomer.get(b.customerId)??[];list.push(b);bindingsByCustomer.set(b.customerId,list);
}
const projectionReceipts:any[]=[];const skippedAnchors:any[]=[];
mkdirSync(join(output,"proofs"),{recursive:true});
for(const customer of delivery.value.customers) {
  const row=rows.get(customer.customerId),scope=scopeRows.get(customer.customerId);
  if(!row||!scope||row.profileSha256!==customer.profileSha256||scope.profileSha256!==customer.profileSha256) throw new Error(`profile_version:${customer.customerId}`);
  const raw=readFileSync(join(research,customer.profileFile),"utf8"),profile=normalizeCustomerResearchProfile(JSON.parse(raw),{preserveAuthoredConflictCitationRoles:true});
  const industryReview=reviews.get(customer.customerId);
  let mapping=row;
  if(industryReview) {
    if(industryReview.profileSha256!==customer.profileSha256) throw new Error(`industry_profile:${customer.customerId}`);
    const gids=industryReview.providerIndustryIds??[],fids=industryReview.industryFactIds??[];
    if(!Array.isArray(gids)||!Array.isArray(fids)||gids.some((id:string)=>!catalog.industryContextDefinitions.some(g=>g.id===id))
      || gids.length && (!fids.length || fids.some((id:string)=>!profile.facts.some(f=>f.id===id&&f.state==="supported"&&f.subject.kind==="customer")))) throw new Error(`industry_evidence:${customer.customerId}`);
    mapping={...row,providerIndustryIds:gids,industryFactIds:fids,industryReview};
  }
  const bindings=[...(bindingsByCustomer.get(customer.customerId)??[])];
  for(const proposal of delivery.value.proposals) for(const anchor of proposal.anchors) if(anchor.customerId===customer.customerId) {
    const criterion=facets.find(f=>f.sourceProposalKey===proposal.key)!;
    if(bindings.some(b=>b.criterionId===criterion.id)) continue;
    const facts=anchor.facts;
    if(!row.matches?.length||!facts.length||facts.some((f:any)=>f.state!=="supported"||f.subject.kind!=="customer")) { skippedAnchors.push({customerId:customer.customerId,criterionId:criterion.id,reason:"not_entirely_supported_own_subject_bundle"});continue; }
    bindings.push({criterionId:criterion.id,definitionVersion:criterion.definitionVersion,customerId:customer.customerId,profileSha256:customer.profileSha256,
      state:"supported",factIds:[...new Set<string>(facts.map((f:any)=>f.factId))],offeringScope:"As scoped by the cited authored facts; retain their entity, offering and time qualifiers.",
      whyMatches:"Explicit authored proposal anchor; the exact evidence bundle and its explanations are preserved.",authoredAt:at,author:"codex",source:"proposal_anchor"});
  }
  const proof=projectCustomerBusinessScopeProof({profileJson:raw,profileSha256:customer.profileSha256,mapping,bindings,validatedAt:at,
    businessScope:{status:scope.scopeStatus,acceptedScope:"Substantive business, services, product families, customer, asset and commercial pages; excludes exhaustive article, catalog and technical archives. Residual limitations remain explicit.",closedAt:scopes.value.at,
      receipt:{file:scopes.file,sha256:scopes.sha256,pointer:`/items/${scope.index}`},profileSha256:customer.profileSha256,wholeSiteStatus:profile.status,wholeSiteDiscoveryStatus:profile.discovery.status}});
  const file=save(`proofs/${customer.customerId}.json`,proof);
  projectionReceipts.push({...file,customerId:customer.customerId,profileSha256:proof.fullProfileSha256,proofSha256:proof.proofSha256,scopeStatus:proof.businessScope.status,rawStatus:proof.status,
    facts:proof.facts.length,bindings:proof.criterionBindings.length,mapped:!!row.matches?.length});
}
const completed={schema:"customer-live-projection-receipt-v1",at,catalogVersion:catalog.version,sourceManifest:catalog.sourceManifest,
  records:projectionReceipts.length,mapped:projectionReceipts.filter(r=>r.mapped).length,unmapped:projectionReceipts.filter(r=>!r.mapped).length,
  criteria:facets.length,bindings:projectionReceipts.reduce((n,r)=>n+r.bindings,0),customersWithBindings:projectionReceipts.filter(r=>r.bindings).length,
  skippedAnchors,outputs,proofs:projectionReceipts,paidCalls:0,cloudWrites:0,wholeSiteStatusRewritten:false};
catalog.cohortProof.customers=projectionReceipts.map(r=>({customerId:r.customerId,profileSha256:r.profileSha256,proofSha256:r.proofSha256}));
catalog.cohortProof.customersWithBindings=completed.customersWithBindings;
catalog.cohortProof.criterionBindings=completed.bindings;
catalog.version=approvedCustomerCatalogVersion(catalog);
normalizeApprovedCustomerCatalog(catalog);
completed.catalogVersion=catalog.version;
outputs[0]=save("approved-catalog.json",catalog);
outputs[1]=save("criterion-aliases.json",{version:catalog.version,criteria:facets.map(f=>({id:f.id,definitionVersion:f.definitionVersion,sourceProposalKey:f.sourceProposalKey,originalScope:f.originalScope,predicate:f.predicate,evidenceRules:f.evidenceRules,exclusions:f.exclusions}))});
save("projection-receipt.json",completed);
console.log(JSON.stringify({...completed,proofs:undefined,skippedAnchors:skippedAnchors.length}));
