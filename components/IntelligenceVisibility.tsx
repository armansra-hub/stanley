"use client";
import {useState} from 'react';
import {DEFAULT_VISIBILITY_POLICY,visibilityReasonLabel,type summarizeVisibility} from '@/lib/intelligence/visibility';
type Diagnostics=ReturnType<typeof summarizeVisibility>&{scope:string;hasMore:boolean;nextCursor:string|null;asOf:string};
export default function IntelligenceVisibility(){
 const [result,setResult]=useState<Diagnostics|null>(null);const [busy,setBusy]=useState(false);const [error,setError]=useState(false);
 const load=async(after?:string|null)=>{setBusy(true);setError(false);try{const response=await fetch(`/api/headhunter/intelligence/visibility${after?'?after='+encodeURIComponent(after):''}`,{cache:'no-store'});if(!response.ok)throw new Error();setResult(await response.json());}catch{setError(true);}finally{setBusy(false);}};
 return <details className="mt-4 rounded border p-3 text-sm"><summary className="cursor-pointer font-medium">Visibility rules and saved-output diagnostics</summary>
  <p className="mt-2 text-xs text-[var(--text-muted)]">Legacy operating traits use {DEFAULT_VISIBILITY_POLICY.topicProbability*100}% topic probability and {DEFAULT_VISIBILITY_POLICY.companyRelevance*100}% company relevance. Exploration shows those native answers down to 50%, still with direct attribution. The 47 new research categories use Jev’s native choice directly, without an additional probability cutoff or semantic judge. It changes this search only; Triggers and TAM grades keep their existing rules.</p>
  <p className="mt-2 text-xs text-[var(--text-muted)]">Trigger defaults remain 80% relevance, 75% concrete development and, for acquisitions, 80% acquirer probability. No measured calibration against human labels has established better defaults. The comparison below counts saved answers that would route under broader 50% cutoffs, retaining classification, identity and date rules. It does not estimate accuracy or change publication.</p>
  <button type="button" disabled={busy} onClick={()=>void load()} className="mt-3 rounded border px-3 py-1.5 text-xs disabled:opacity-50">{busy?'Reading saved answers…':'Inspect saved-output page'}</button>
  {error&&<p role="alert" className="mt-2 text-xs">Saved-output diagnostics are temporarily unavailable.</p>}
  {result&&<div className="mt-3 space-y-2 text-xs"><p>{result.observations} observations · {result.packets} native packets · {result.currentEligiblePackets} pass current semantic/date rules · {result.additionalExploratoryPackets} additional packets under the broader comparison. Passage availability, source/company rules and deduplication still apply.</p>
   <p className="text-[var(--text-muted)]">{result.scope}</p>
   <ul className="space-y-1">{Object.entries(result.reasons).sort((a,b)=>b[1]-a[1]).map(([reason,count])=><li key={reason}>{visibilityReasonLabel(reason)}: {count}</li>)}</ul>
   {result.examples.map((example,index)=><p key={example.observationId+index}><a href={example.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] hover:underline">{example.companyName}: {example.title}</a> · {visibilityReasonLabel(example.reason)} · relevance {Math.round(example.scores.companyRelevance*100)}%, concrete {Math.round(example.scores.concreteEvent*100)}%</p>)}
   {result.hasMore&&result.nextCursor&&<button type="button" disabled={busy} onClick={()=>void load(result.nextCursor)} className="rounded border px-3 py-1.5 disabled:opacity-50">Inspect next saved-output page</button>}
  </div>}
 </details>;
}
