-- Authorized Codex review of existing news jobs while paid Jev is paused.
-- No queue copy, paid dispatch, grade edit, source deletion or rollout activation.
begin;

-- A nullable scalar adds no table rewrite. Indexing historical result JSONB
-- would detoast every paid packet just to discover that no request ID exists.
alter table public.intelligence_jobs add column if not exists codex_news_request_id uuid;
create unique index if not exists intelligence_codex_news_request
  on public.intelligence_jobs (codex_news_request_id) where codex_news_request_id is not null;

create or replace function public.intelligence_codex_news_snapshot(p_job uuid)
returns jsonb language sql stable security definer set search_path=public,extensions,pg_temp as $$
 select jsonb_build_object('observation',jsonb_build_object(
  'id',o.id,'company_id',o.company_id,'source_kind',o.source_kind,'source_url',o.source_url,'title',o.title,
  'evidence_text',o.evidence_text,'content_hash',o.content_hash,'event_date',o.event_date,'observed_at',o.observed_at,
  'is_current',o.is_current,'feedback_excluded',o.feedback_excluded,'metadata',o.metadata,'sections',o.sections),
  'company',jsonb_build_object('id',c.id,'name',c.name,'domain',c.domain,'website_raw',c.website_raw,'city',c.city,'state',c.state,
   'netsuite_internal_id',c.netsuite_internal_id,'status',c.status,'lists',c.lists,'tal_claimed',c.tal_claimed,'record_dead',c.record_dead,
   'description',c.description,'subindustry',c.subindustry,'ns_industry',c.ns_industry),
  'identity',coalesce(company_identity_source_context(c.id),'{}'::jsonb))
 from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id join companies c on c.id=o.company_id
 where j.id=p_job;
$$;

create or replace function public.intelligence_codex_news_packet(p_job uuid)
returns jsonb language sql stable security definer set search_path=public,extensions,pg_temp as $$
 select jsonb_build_object('jobId',j.id,'status',j.status,'lease',j.lease_token,'leaseUntil',j.lease_until,
  'snapshotHash',encode(digest(convert_to(s.value::text,'UTF8'),'sha256'),'hex'),
  'snapshot',s.value,'review',j.result->'codexNews',
  'publication',jsonb_build_object('event',(select jsonb_build_object('id',e.id,'meta',e.meta) from app_events e
    where e.id=(j.result->'codexNews'->'receipt'->>'eventId')::uuid),
   'trigger',(select jsonb_build_object('id',t.id,'company_id',t.company_id,'type',t.type,'signal_date',t.signal_date,'source_url',t.source_url,'metadata',t.metadata) from triggers t
    where t.id=(j.result->'codexNews'->'receipt'->>'triggerId')::uuid)))
 from intelligence_jobs j cross join lateral (select intelligence_codex_news_snapshot(j.id) value) s where j.id=p_job;
$$;

create or replace function public.intelligence_codex_news(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare j intelligence_jobs%rowtype; o intelligence_observations%rowtype; c companies%rowtype;
 v jsonb; s jsonb; h text; a jsonb; t jsonb; r jsonb; receipt jsonb; existing triggers%rowtype;
 request_id uuid; actor text; lease uuid; event_id uuid; created boolean:=false; slots integer; text_units integer;
 bound_event uuid; bound_trigger uuid;
begin
 if jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>64000 then raise exception 'Invalid news request'; end if;
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
  if request_id is null or actor is null or actor!~'^[a-zA-Z0-9_:/.-]{3,180}$' then raise exception 'Invalid reader identity'; end if;
  perform pg_advisory_xact_lock(hashtextextended('codex-news-request:'||request_id,0));
  select * into j from intelligence_jobs where codex_news_request_id=request_id for update;
  if found then
   if j.result->'codexNews'->>'actor' is distinct from actor or j.result->'codexNews'->>'requestId' is distinct from request_id::text then raise exception 'Request identity conflict'; end if;
   return intelligence_codex_news_packet(j.id);
  end if;
  -- Explicitly scoped to the existing paused provider policy. Never enable it.
  perform 1 from intelligence_jev_budget_policy where id='jev-rollout-2026-09-24' and not enabled for share;
  if not found or not coalesce((select enabled from intelligence_config where id=1),false) then raise exception 'Codex review admission unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  select least(12-count(*)::integer,3-count(*) filter(where codex_news_request_id is not null)::integer)
   into slots from intelligence_jobs where status='running' and lease_until>now();
  if slots<1 then return null; end if;
  select q.* into j from intelligence_jobs q join intelligence_observations n on n.id=q.observation_id join companies co on co.id=n.company_id
   where q.kind='interpret' and n.source_kind='news' and n.is_current and not n.feedback_excluded
   and q.status='queued' and (q.due_at<=now() or q.last_error in('budget_deferred','intelligence_disabled'))
   and q.codex_news_request_id is null
   -- An unresolved paid request remains recoverable by its existing owner.
   and coalesce(q.result->'pendingRequest','null'::jsonb)='null'::jsonb
   and not ('tam_duplicate'=any(coalesce(co.lists,'{}'::text[])))
   and (co.tal_claimed is true or (co.lists @> array['netsuite_tam']::text[] and co.status is distinct from 'removed_from_tam'))
   order by co.tal_claimed desc nulls last,q.priority desc,q.created_at,q.id limit 1 for update of q skip locked;
  if not found then return null; end if;
  -- Inspect only the selected row; never overwrite an orphaned restored receipt.
  if j.result->'codexNews' is not null then raise exception 'Existing news receipt requires reconciliation'; end if;
  s:=intelligence_codex_news_snapshot(j.id); h:=encode(digest(convert_to(s::text,'UTF8'),'sha256'),'hex'); lease:=gen_random_uuid();
  update intelligence_jobs set status='running',lease_token=lease,lease_until=now()+interval '20 minutes',codex_news_request_id=request_id,
   result=coalesce(result,'{}'::jsonb)||jsonb_build_object('codexNews',jsonb_build_object('version','codex-news-review-v1',
    'actor',actor,'requestId',request_id,'claimLease',lease,'snapshotHash',h,'claimedAt',now())) where id=j.id;
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
 if j.kind<>'interpret' or o.source_kind<>'news' or not o.is_current or o.feedback_excluded
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
 if coalesce(o.metadata->>'articleBodyAvailable','false')<>'true' or o.metadata->>'evidenceKind' is distinct from 'article_body'
  or coalesce(o.metadata->>'textTruncated','false')='true' or coalesce(o.metadata->>'sourceTruncated','false')='true' then raise exception 'Original article is incomplete'; end if;
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
  if t is null or t='null'::jsonb or t->>'source_url' is distinct from o.source_url or t->>'source_name' is distinct from 'Codex · Independently reviewed public news'
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
   'Codex independently reviewed one original news source',jsonb_build_object('jobId',j.id,'observationId',o.id,'companyId',c.id,
    'snapshotHash',h,'decisionHash',v->>'decisionHash','disposition',a->>'disposition','triggerId',existing.id)) returning id into event_id;
 receipt:=jsonb_build_object('jobId',j.id,'observationId',o.id,'companyId',c.id,'snapshotHash',h,'decisionHash',v->>'decisionHash',
  'disposition',a->>'disposition','triggerId',existing.id,'eventId',event_id,'newTrigger',created,'completedAt',now());
 -- Retain all paid packets, pending receipts and prior annotations as history.
 update intelligence_jobs set status='complete',lease_token=null,lease_until=null,finished_at=now(),last_error=null,
  result=jsonb_set(result,'{codexNews}',v||jsonb_build_object('independentReview',r,'receipt',receipt,
   'priorObservation',jsonb_build_object('attributes',o.attributes,'interpretationVersion',o.interpretation_version,'interpretedAt',o.interpreted_at))) where id=j.id;
 update intelligence_observations set attributes=coalesce(attributes,'{}'::jsonb)||jsonb_build_object('codexNewsReview',
  jsonb_build_object('version','codex-news-review-v1','analysis',a,'independentReview',r,'receipt',receipt)),
  interpretation_version='codex-news-review-v1',interpreted_at=now() where id=o.id;
 return intelligence_codex_news_packet(j.id);
end $$;

revoke all on function public.intelligence_codex_news_snapshot(uuid),public.intelligence_codex_news_packet(uuid),public.intelligence_codex_news(text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_codex_news_snapshot(uuid),public.intelligence_codex_news_packet(uuid),public.intelligence_codex_news(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
