-- Audited reconciliation of an expired Codex claim with an invalidated snapshot.
-- Appends an explicit incomplete hold; preserves every existing action unchanged.
begin;
create or replace function public.intelligence_codex_news(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare j intelligence_jobs%rowtype; o intelligence_observations%rowtype; c companies%rowtype;
 v jsonb; s jsonb; h text; a jsonb; t jsonb; r jsonb; receipt jsonb; existing triggers%rowtype;
 request_id uuid; actor text; lease uuid; event_id uuid; created boolean:=false; slots integer; text_units integer;
 bound_event uuid; bound_trigger uuid; candidate_id uuid; selected_job uuid;
 source_kind_filter text; company_ids uuid[]; observed_through timestamptz; selection jsonb; observation_id_filter uuid;
begin
 if jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>64000 then raise exception 'Invalid news request'; end if;
 if p_action='reconcile_hold' then
  -- Explicit incident reconciliation, never ordinary completion or a new lease.
  -- The old review remains immutable. A separate held-at snapshot records what
  -- invalidated it; the job keeps its claim identity so neither worker reclaims it.
  if (select count(*) from jsonb_object_keys(p_payload))<>11
   or exists(select 1 from jsonb_object_keys(p_payload) k where k not in
    ('action','jobId','requestId','lease','snapshotHash','currentSnapshotHash','taskId','reviewerTaskId','incidentId','evidenceSha256','reason'))
   or p_payload->>'action' is distinct from 'reconcile_hold'
   or coalesce(p_payload->>'taskId','')!~'^[a-zA-Z0-9_:/.-]{3,180}$'
   or coalesce(p_payload->>'reviewerTaskId','')!~'^[a-zA-Z0-9_:/.-]{3,180}$'
   or p_payload->>'taskId'=p_payload->>'reviewerTaskId'
   or coalesce(p_payload->>'snapshotHash','')!~'^[a-f0-9]{64}$'
   or coalesce(p_payload->>'currentSnapshotHash','')!~'^[a-f0-9]{64}$'
   or coalesce(p_payload->>'evidenceSha256','')!~'^[a-f0-9]{64}$'
   or coalesce(p_payload->>'incidentId','')!~'^[a-f0-9]{8}-([a-f0-9]{4}-){3}[a-f0-9]{12}$'
   or length(trim(coalesce(p_payload->>'reason',''))) not between 30 and 2000 then raise exception 'Invalid incident reconciliation'; end if;
  select * into j from intelligence_jobs where id=(p_payload->>'jobId')::uuid for update;
  if not found then raise exception 'Exact incident job missing'; end if;
  v:=j.result->'codexNews'; lease:=(p_payload->>'lease')::uuid;
  if v is null or j.codex_news_request_id is null
   or v->>'requestId' is distinct from j.codex_news_request_id::text
   or v->>'requestId' is distinct from p_payload->>'requestId'
   or v->>'snapshotHash' is distinct from p_payload->>'snapshotHash'
   or v->>'claimLease' is distinct from lease::text then raise exception 'Incident claim identity mismatch'; end if;
  if v ? 'reconciliation' then
   if v->'reconciliation'->'request' is distinct from p_payload or j.status<>'queued'
    or j.lease_token is not null or j.lease_until is not null or v ? 'receipt'
    or v->>'hold' is distinct from p_payload->>'reason' then raise exception 'Incident reconciliation retry differs'; end if;
   receipt:=v->'reconciliation'->'receipt';
   perform 1 from app_events where id=(receipt->>'eventId')::uuid and entity_id=j.id::text
    and kind='intelligence.codex_news_held' and meta=receipt-'eventId';
   if not found then raise exception 'Incident event readback missing'; end if;
   return intelligence_codex_news_packet(j.id);
  end if;
  if j.kind<>'interpret' or j.status<>'running' or j.lease_token is distinct from lease
   or j.lease_until is null or j.lease_until>now() or j.finished_at is not null
   or v ? 'receipt' or v ? 'hold'
   or coalesce(j.result->'pendingRequest','null'::jsonb)<>'null'::jsonb then raise exception 'Incident requires expired unresolved Codex claim'; end if;
  select * into o from intelligence_observations where id=j.observation_id for update;
  if not found or o.source_kind not in('news','website','job') then raise exception 'Incident original source missing'; end if;
  perform 1 from companies where id=o.company_id for share;
  if not found then raise exception 'Incident company missing'; end if;
  s:=intelligence_codex_news_snapshot(j.id); h:=encode(digest(convert_to(s::text,'UTF8'),'sha256'),'hex');
  if h is distinct from p_payload->>'currentSnapshotHash' or h=v->>'snapshotHash' then raise exception 'Incident current snapshot mismatch'; end if;
  receipt:=jsonb_build_object('version','codex-stale-hold-v1','jobId',j.id,'requestId',j.codex_news_request_id,
   'observationId',o.id,'companyId',o.company_id,'disposition','incomplete_hold','incidentId',p_payload->>'incidentId',
   'originalSnapshotHash',v->>'snapshotHash','currentSnapshotHash',h,'evidenceSha256',p_payload->>'evidenceSha256',
   'taskId',p_payload->>'taskId','reviewerTaskId',p_payload->>'reviewerTaskId','reason',p_payload->>'reason',
   'priorStatus',j.status,'priorLeaseUntil',j.lease_until,'heldAt',now(),'triggerId',null,'analysisCompleted',false);
  insert into app_events(module,kind,entity_type,entity_id,summary,meta)
   values('headhunter','intelligence.codex_news_held','intelligence_jobs',j.id::text,
    'Expired Codex source claim reconciled to an explicit incomplete hold',receipt) returning id into event_id;
  receipt:=receipt||jsonb_build_object('eventId',event_id);
  update intelligence_jobs set status='queued',lease_token=null,lease_until=null,last_error='codex_source_review_hold',
   result=jsonb_set(result,'{codexNews}',v||jsonb_build_object('hold',p_payload->>'reason','heldAt',now(),
    'reconciliation',jsonb_build_object('request',p_payload,'receipt',receipt,'currentSnapshot',s))) where id=j.id;
  return intelligence_codex_news_packet(j.id);
 end if;

 if p_action='status' then
  if p_payload->>'jobId' is null and p_payload->>'requestId' is null then raise exception 'Exact news identity required'; end if;
  -- Separate exact-key branches keep recovery on the PK or scalar index even
  -- after PostgreSQL switches this function to a generic prepared plan.
  if p_payload->>'jobId' is not null then
   select * into j from intelligence_jobs where id=(p_payload->>'jobId')::uuid and codex_news_request_id is not null;
   if found and p_payload->>'requestId' is not null and j.codex_news_request_id is distinct from (p_payload->>'requestId')::uuid then return null; end if;
  else
   select * into j from intelligence_jobs where codex_news_request_id=(p_payload->>'requestId')::uuid;
  end if;
  if not found then return null; end if;
  if j.result->'codexNews'->>'requestId' is distinct from j.codex_news_request_id::text then raise exception 'Request receipt identity conflict'; end if;
  return intelligence_codex_news_packet(j.id);
 end if;
 if p_action='claim' then
  request_id:=(p_payload->>'requestId')::uuid; actor:=p_payload->>'taskId';
  source_kind_filter:=coalesce(p_payload->>'sourceKind','news');
  if source_kind_filter not in('news','website','job') then raise exception 'Unsupported Codex source kind'; end if;
  if (p_payload ? 'companyIds') is distinct from (p_payload ? 'observedThrough') then raise exception 'Finite scope needs company IDs and cutoff'; end if;
  if p_payload ? 'companyIds' then
   if jsonb_typeof(p_payload->'companyIds') is distinct from 'array' then raise exception 'Invalid company scope'; end if;
   if jsonb_array_length(p_payload->'companyIds') not between 1 and 100 then raise exception 'Invalid company scope'; end if;
   select array_agg(value::uuid) into company_ids from jsonb_array_elements_text(p_payload->'companyIds');
   if cardinality(company_ids)<>(select count(distinct x) from unnest(company_ids) x) then raise exception 'Duplicate company scope'; end if;
   observed_through:=(p_payload->>'observedThrough')::timestamptz;
   if observed_through is null or not isfinite(observed_through) or observed_through>now() then raise exception 'Invalid observation cutoff'; end if;
  end if;
  if p_payload ? 'observationId' then
   if jsonb_typeof(p_payload->'observationId') is distinct from 'string'
    or (p_payload->>'observationId')!~'^[a-fA-F0-9]{8}-([a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12}$'
    or jsonb_typeof(p_payload->'sourceKind') is distinct from 'string'
    or cardinality(company_ids) is distinct from 1 then raise exception 'Exact observation requires UUID, explicit source kind and one scoped company'; end if;
   observation_id_filter:=(p_payload->>'observationId')::uuid;
  end if;
  selection:=jsonb_build_object('sourceKind',source_kind_filter,'companyIds',to_jsonb(company_ids),'observedThrough',observed_through);
  -- Absent selector must retain the exact legacy selection shape for recovery.
  if observation_id_filter is not null then selection:=selection||jsonb_build_object('observationId',observation_id_filter); end if;
  if request_id is null or actor is null or actor!~'^[a-zA-Z0-9_:/.-]{3,180}$' then raise exception 'Invalid reader identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('codex-news-request:'||request_id,0));
  select * into j from intelligence_jobs where codex_news_request_id=request_id for update;
  if found then
   if j.result->'codexNews'->>'actor' is distinct from actor or j.result->'codexNews'->>'requestId' is distinct from request_id::text then raise exception 'Request identity conflict'; end if;
   if coalesce(j.result->'codexNews'->'selection',jsonb_build_object('sourceKind','news','companyIds',null,'observedThrough',null)) is distinct from selection then raise exception 'Request selection conflict'; end if;
   return intelligence_codex_news_packet(j.id);
  end if;
  -- Explicitly scoped to the existing paused provider policy. Never enable it.
  perform 1 from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' and not enabled for share;
  if not found or not coalesce((select enabled from intelligence_config where id=1),false) then raise exception 'Codex review admission unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  select least(12-count(*)::integer,3-count(*) filter(where codex_news_request_id is not null)::integer)
   into slots from intelligence_jobs where status='running' and lease_until>now();
  if slots<1 then return null; end if;

 -- codex-news-scalar-candidates-v1: never sort or filter all paid result bodies.
 for candidate_id in
  with eligible_news as materialized (
   select n.id from companies co join intelligence_observations n on n.company_id=co.id
   where co.tal_claimed is true and not ('tam_duplicate'=any(coalesce(co.lists,'{}'::text[])))
    and n.source_kind=source_kind_filter
     and (observation_id_filter is null or n.id=observation_id_filter)
    and (company_ids is null or co.id=any(company_ids))
    and (observed_through is null or n.observed_at<=observed_through) and n.is_current and not n.feedback_excluded
  )
  select q.id from eligible_news n join intelligence_jobs q on q.observation_id=n.id
   where q.kind='interpret' and q.status='queued' and q.codex_news_request_id is null
    and (q.due_at<=now() or q.last_error in('budget_deferred','intelligence_disabled'))
   order by q.priority desc,q.created_at,q.id for update of q skip locked
 loop
  select * into j from intelligence_jobs where id=candidate_id;
  if coalesce(j.result->'pendingRequest','null'::jsonb)='null'::jsonb then selected_job:=j.id; exit; end if;
 end loop;
 if selected_job is null then
  for candidate_id in
   with eligible_news as materialized (
    select n.id from companies co join intelligence_observations n on n.company_id=co.id
    where co.tal_claimed is not true and co.lists @> array['netsuite_tam']::text[]
     and co.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(co.lists,'{}'::text[])))
     and n.source_kind=source_kind_filter
     and (observation_id_filter is null or n.id=observation_id_filter)
    and (company_ids is null or co.id=any(company_ids))
    and (observed_through is null or n.observed_at<=observed_through) and n.is_current and not n.feedback_excluded
   )
   select q.id from eligible_news n join intelligence_jobs q on q.observation_id=n.id
    where q.kind='interpret' and q.status='queued' and q.codex_news_request_id is null
     and (q.due_at<=now() or q.last_error in('budget_deferred','intelligence_disabled'))
    order by q.priority desc,q.created_at,q.id for update of q skip locked
  loop
   select * into j from intelligence_jobs where id=candidate_id;
   if coalesce(j.result->'pendingRequest','null'::jsonb)='null'::jsonb then selected_job:=j.id; exit; end if;
  end loop;
 end if;
 if selected_job is null then return null; end if;
  -- Inspect only the selected row; never overwrite an orphaned restored receipt.
  if j.result->'codexNews' is not null then raise exception 'Existing news receipt requires reconciliation'; end if;
  s:=intelligence_codex_news_snapshot(j.id); h:=encode(digest(convert_to(s::text,'UTF8'),'sha256'),'hex'); lease:=gen_random_uuid();
  update intelligence_jobs set status='running',lease_token=lease,lease_until=now()+interval '20 minutes',codex_news_request_id=request_id,
   result=coalesce(result,'{}'::jsonb)||jsonb_build_object('codexNews',jsonb_build_object('version','codex-news-review-v1',
    'selection',selection,'actor',actor,'requestId',request_id,'claimLease',lease,'snapshotHash',h,'claimedAt',now())) where id=j.id;
  return intelligence_codex_news_packet(j.id);
 end if;
 if p_action not in('read','analyze','finish','hold','renew') then raise exception 'Unknown news action'; end if;
 select * into j from intelligence_jobs where id=(p_payload->>'jobId')::uuid for update;
 if not found then return null; end if;
 v:=j.result->'codexNews'; lease:=(p_payload->>'lease')::uuid;
 if v->>'requestId' is distinct from j.codex_news_request_id::text then raise exception 'Request receipt identity conflict'; end if;
 if v is null or v->>'claimLease' is distinct from lease::text then raise exception 'News claim mismatch'; end if;
 -- Identical completion retries only return the saved receipt; never republish.
 if j.status='complete' and p_action in('read','finish') then
  if p_action='finish' and v->'independentReview' is distinct from p_payload->'review' then raise exception 'Completion retry differs'; end if;
  return intelligence_codex_news_packet(j.id);
 end if;
 if j.status<>'running' or j.lease_token is distinct from lease or j.lease_until is null or (j.lease_until<=now() and p_action<>'renew') then raise exception 'News lease expired'; end if;
 select * into o from intelligence_observations where id=j.observation_id for update;
 select * into c from companies where id=o.company_id for share;
 if j.kind<>'interpret' or o.source_kind not in('news','website','job') or not o.is_current or o.feedback_excluded
  or 'tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))
  or not (c.tal_claimed is true or (coalesce(c.lists,'{}'::text[]) @> array['netsuite_tam']::text[] and c.status is distinct from 'removed_from_tam')) then raise exception 'News source is no longer eligible'; end if;
 s:=intelligence_codex_news_snapshot(j.id); h:=encode(digest(convert_to(s::text,'UTF8'),'sha256'),'hex');
 if h is distinct from v->>'snapshotHash' or h is distinct from p_payload->>'snapshotHash' then raise exception 'News snapshot changed'; end if;
 if p_action='renew' then
  if p_payload->>'taskId' is distinct from v->>'actor' then raise exception 'Reader identity mismatch'; end if;
  perform 1 from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' and not enabled for share;
  if not found then raise exception 'Codex review admission unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  select least(12-count(*)::integer,3-count(*) filter(where codex_news_request_id is not null)::integer)
   into slots from intelligence_jobs where status='running' and lease_until>now() and id<>j.id;
  if slots<1 then raise exception 'News worker capacity unavailable'; end if;
  update intelligence_jobs set lease_until=now()+interval '20 minutes' where id=j.id;
  return intelligence_codex_news_packet(j.id);
 end if;
 if p_action='read' then return intelligence_codex_news_packet(j.id); end if;
 if p_action='hold' then
  if p_payload->>'taskId' is distinct from v->>'actor' or length(coalesce(p_payload->>'reason','')) not between 30 and 2000 then raise exception 'Invalid news hold'; end if;
  update intelligence_jobs set status='queued',lease_token=null,lease_until=null,last_error='codex_source_review_hold',
   result=jsonb_set(result,'{codexNews}',v||jsonb_build_object('hold',p_payload->>'reason','heldAt',now())) where id=j.id;
  return intelligence_codex_news_packet(j.id);
 end if;
 if o.metadata->'structuredAward'='true'::jsonb then raise exception 'Dedicated federal policy required'; end if;
 if o.source_kind='news' then
  if coalesce(o.metadata->>'articleBodyAvailable','false')<>'true' or o.metadata->>'evidenceKind' is distinct from 'article_body'
   or coalesce(o.metadata->>'textTruncated','false')='true' or coalesce(o.metadata->>'sourceTruncated','false')='true' then raise exception 'Original article is incomplete'; end if;
 else
  text_units:=length(o.evidence_text)+length(regexp_replace(o.evidence_text,U&'[\0001-\FFFF]','','g'));
  if o.metadata->'textTruncated' is distinct from 'false'::jsonb or o.metadata->'sourceTruncated'='true'::jsonb
   or length(btrim(o.evidence_text))=0 or o.metadata->'retainedCharacters' is distinct from to_jsonb(text_units)
   or o.metadata->'sourceCharacters' is distinct from to_jsonb(text_units) then raise exception 'Original source is incomplete'; end if;
  if o.source_kind='website' and (o.metadata->'discovery'->>'collector' is distinct from 'website'
   or coalesce(o.metadata->>'meaningfulContentHash','')!~'^[a-f0-9]{64}$') then raise exception 'Website completeness provenance missing'; end if;
  if o.source_kind='job' and (o.metadata->'bodySchemaValidated' is distinct from 'true'::jsonb
   or o.metadata->>'bodySchemaVersion' is distinct from 'ats-body-schema-v1'
   or o.metadata->'descriptionAvailable' is distinct from 'true'::jsonb
   or coalesce(o.metadata->>'atsJobKey','')='' or coalesce(o.metadata->>'atsToken','')=''
   or coalesce(o.metadata->>'atsType','') not in('greenhouse','lever','ashby','smartrecruiters','recruitee','workable')) then raise exception 'Job completeness provenance missing'; end if;
 end if;
 -- JS span units are UTF-16: supplementary code points contribute two units.
 text_units:=length(o.evidence_text)+length(regexp_replace(o.evidence_text,U&'[\0001-\FFFF]','','g'));
 if p_action='analyze' then
  a:=p_payload->'analysis';
  if a->'reader'->>'taskId' is distinct from v->>'actor' or a->'reader'->>'snapshotHash' is distinct from h
   or a->'reader'->>'fullTextRead' is distinct from 'true' or a->'reader'->>'readStart' is distinct from '0'
   or (a->'reader'->>'readEnd')::integer is distinct from text_units
   or coalesce(p_payload->>'decisionHash','')!~'^[a-f0-9]{64}$' then raise exception 'Invalid news analysis'; end if;
  if v->'analysis' is not null and (v->'analysis' is distinct from a or v->>'decisionHash' is distinct from p_payload->>'decisionHash') then raise exception 'Analysis already recorded'; end if;
  update intelligence_jobs set result=jsonb_set(result,'{codexNews}',v||jsonb_build_object('analysis',a,'decisionHash',p_payload->>'decisionHash')) where id=j.id;
  return intelligence_codex_news_packet(j.id);
 end if;
 a:=v->'analysis'; r:=p_payload->'review'; t:=p_payload->'trigger';
 if a is null or r->>'approved' is distinct from 'true' or r->>'decisionHash' is distinct from v->>'decisionHash'
  or r->'reviewer'->>'snapshotHash' is distinct from h or r->'reviewer'->>'fullTextRead' is distinct from 'true'
  or r->'reviewer'->>'readStart' is distinct from '0' or (r->'reviewer'->>'readEnd')::integer is distinct from text_units
  or coalesce(r->'reviewer'->>'taskId','')!~'^[a-zA-Z0-9_:/.-]{3,180}$'
  or r->'reviewer'->>'taskId'=v->>'actor' then raise exception 'Independent review required'; end if;
 if a->>'disposition'='publish' then
  if t is null or t='null'::jsonb or t->>'source_url' is distinct from o.source_url or t->>'source_name' is distinct from ('Codex · Independently reviewed public '||o.source_kind)
   or (t->>'signal_date')::timestamptz is distinct from o.event_date
   or t->'evidence'->>'observationId' is distinct from o.id::text
   or substring(o.evidence_text from (t->>'passageStart')::integer+1 for (t->>'passageLength')::integer) is distinct from t->'evidence'->>'excerpt'
   or length(coalesce(t->'evidence'->>'excerpt','')) not between 1 and 1200
   or o.event_date is null or o.event_date>now() or o.event_date<now()-interval '180 days'
   or t->>'type' not in('funding','ma','new_entity','finance_hire','press','operating_change','erp_tech','hiring_velocity','employee_growth','government_announcement') then raise exception 'Invalid reviewed publication'; end if;
  perform pg_advisory_xact_lock(hashtextextended('codex-news-source:'||c.id::text||o.source_url,0));
  perform pg_advisory_xact_lock(hashtextextended('intelligence-event:'||c.id::text,0));
  select e.id,e.trigger_id into bound_event,bound_trigger from intelligence_event_observations m
   join intelligence_events e on e.id=m.event_id where m.observation_id=o.id and e.company_id=c.id for update of e;
  if bound_trigger is not null and not exists(select 1 from triggers where id=bound_trigger and company_id=c.id and source_url=o.source_url) then
   raise exception 'Existing event requires explicit reconciliation';
  end if;
  select * into existing from triggers where company_id=c.id and source_url=o.source_url for update;
  receipt:=jsonb_build_object('version','codex-news-review-v1','interpretation','codex','independentlyReviewed',true,
   'jobId',j.id,'observationId',o.id,'snapshotHash',h,'decisionHash',v->>'decisionHash','reader',a->'reader','reviewer',r->'reviewer',
   'analysis',a,'reviewRationale',r->>'rationale','sourceEvidence',t->'evidence');
  if found then
   -- Retain the original source owner's fields, and never revive quarantined evidence.
   if coalesce(existing.metadata->'stanley_quarantine'->>'active','false')='true'
    or coalesce(existing.metadata->>'intelligenceFeedbackExcluded','false')='true'
    or existing.metadata->>'contractEventMergedInto' is not null or coalesce(existing.metadata->>'contractTimingInactive','false')='true'
    or existing.type is distinct from t->>'type' or existing.signal_date is distinct from o.event_date then raise exception 'Existing source requires explicit reconciliation'; end if;
   update triggers set metadata=coalesce(metadata,'{}'::jsonb)||jsonb_build_object('codexNewsFindings',
    coalesce(metadata->'codexNewsFindings','{}'::jsonb)||jsonb_build_object(j.id::text,receipt)) where id=existing.id;
  else
   insert into triggers(company_id,type,strength,half_life_days,summary,source_name,source_url,signal_date,metadata)
    values(c.id,t->>'type',(t->>'strength')::integer,(t->>'half_life_days')::integer,t->>'summary',t->>'source_name',o.source_url,o.event_date,
     jsonb_build_object('intelligenceEvidence',t->'evidence','codexNewsFindings',jsonb_build_object(j.id::text,receipt))) returning * into existing;
   created:=true;
   if c.tal_claimed is true then update companies set tal_alert=true where id=c.id and tal_claimed is true; end if;
  end if;
  if bound_event is not null and not intelligence_event_bind_trigger(bound_event,existing.id) then raise exception 'Event binding not confirmed'; end if;
 elsif a->>'disposition'<>'no_signal' or t is distinct from 'null'::jsonb then raise exception 'Invalid review disposition'; end if;
 insert into app_events(module,kind,entity_type,entity_id,summary,meta)
  values('headhunter','intelligence.codex_news_reviewed','intelligence_jobs',j.id::text,
   'Codex independently reviewed one original public source',jsonb_build_object('jobId',j.id,'observationId',o.id,'companyId',c.id,
    'snapshotHash',h,'decisionHash',v->>'decisionHash','sourceKind',o.source_kind,'disposition',a->>'disposition','triggerId',existing.id)) returning id into event_id;
 receipt:=jsonb_build_object('jobId',j.id,'observationId',o.id,'companyId',c.id,'snapshotHash',h,'decisionHash',v->>'decisionHash',
  'sourceKind',o.source_kind,'disposition',a->>'disposition','triggerId',existing.id,'eventId',event_id,'newTrigger',created,'completedAt',now());
 -- Retain all paid packets, pending receipts and prior annotations as history.
 update intelligence_jobs set status='complete',lease_token=null,lease_until=null,finished_at=now(),last_error=null,
  result=jsonb_set(result,'{codexNews}',v||jsonb_build_object('independentReview',r,'receipt',receipt,
   'priorObservation',jsonb_build_object('attributes',o.attributes,'interpretationVersion',o.interpretation_version,'interpretedAt',o.interpreted_at))) where id=j.id;
 update intelligence_observations set attributes=coalesce(attributes,'{}'::jsonb)||jsonb_build_object('codexNewsReview',
  jsonb_build_object('version','codex-news-review-v1','analysis',a,'independentReview',r,'receipt',receipt)),
  interpretation_version='codex-news-review-v1',interpreted_at=now() where id=o.id;
 return intelligence_codex_news_packet(j.id);
end $$;

revoke all on function public.intelligence_codex_news(text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_codex_news(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
