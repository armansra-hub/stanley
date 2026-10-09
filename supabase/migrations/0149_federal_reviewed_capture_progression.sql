-- Consume a completed canonical source review. Never publish or reinterpret.
begin;
create or replace function public.inspect_federal_reviewed_capture(p_company_id uuid)
returns jsonb language sql stable security definer set search_path=public,extensions,pg_temp as $$
 select jsonb_build_object('companyId',p_company_id,'continuation',cursor->'discoveryContinuations'->p_company_id::text,
   'continuationSha256',encode(digest(convert_to((cursor->'discoveryContinuations'->p_company_id::text)::text,'UTF8'),'sha256'),'hex'),
   'cursorSha256',encode(digest(convert_to(cursor::text,'UTF8'),'sha256'),'hex'),
   'leaseToken',lease_token,'leaseUntil',lease_until,
   'hashEncoding','postgres-jsonb-text-v1','manualSourceOnly',cursor->'discoveryManualSourceOnly')
 from public_growth_sweep_state where source='federal-discovery';
$$;

create or replace function public.consume_federal_reviewed_capture(p_request jsonb,p_lease_token uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare s public_growth_sweep_state%rowtype; j intelligence_jobs%rowtype; o intelligence_observations%rowtype; c companies%rowtype;
 e app_events%rowtype; finish_event app_events%rowtype; hold_event app_events%rowtype;
 operation_id uuid; company_id uuid; review jsonb; receipt jsonb; scope jsonb; source_receipt jsonb;
 prior jsonb; current_cont jsonb; expected_cont jsonb; capture jsonb; next_map jsonb; next_cursor jsonb; mode jsonb; hold jsonb;
 retired_ids jsonb; terminal boolean; key text; units integer; prior_coverage jsonb; manual_cutoff date; existing_mode boolean;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>3000
  or (select count(*) from jsonb_object_keys(p_request))<>8
  or exists(select 1 from jsonb_object_keys(p_request) k where k not in
   ('operationId','companyId','expectedContinuationSha256','jobId','finishEventId','snapshotHash','decisionHash','manualRunCutoff'))
  or exists(select 1 from jsonb_each(p_request) x where jsonb_typeof(x.value)<>'string') then raise exception 'invalid reviewed capture request'; end if;
 foreach key in array array['operationId','companyId','jobId','finishEventId'] loop
  if coalesce(p_request->>key,'')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception 'invalid reviewed capture identity'; end if;
 end loop;
 foreach key in array array['expectedContinuationSha256','snapshotHash','decisionHash'] loop
  if coalesce(p_request->>key,'')!~'^[0-9a-f]{64}$' then raise exception 'invalid reviewed capture hash'; end if;
 end loop;
 if coalesce(p_request->>'manualRunCutoff','')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid manual cutoff'; end if;
 manual_cutoff:=(p_request->>'manualRunCutoff')::date;
 if to_char(manual_cutoff,'YYYY-MM-DD')<>p_request->>'manualRunCutoff' or manual_cutoff>(now() at time zone 'UTC')::date or manual_cutoff<'2007-10-01' then raise exception 'invalid manual cutoff'; end if;
 operation_id:=(p_request->>'operationId')::uuid; company_id:=(p_request->>'companyId')::uuid;
 select * into s from public_growth_sweep_state where source='federal-discovery' for update;
 if not found then raise exception 'federal state missing'; end if;
 select * into e from app_events where id=operation_id;
 if found then
  if e.module is distinct from 'headhunter' or e.kind is distinct from 'federal.discovery.capture_review_consumed'
   or e.entity_type is distinct from 'cron' or e.entity_id is distinct from 'federal-discovery'
   or e.meta->'request' is distinct from p_request then raise exception 'review consumption operation conflict'; end if;
  return e.meta;
 end if;
 if p_lease_token is null or s.lease_token is distinct from p_lease_token or s.lease_until is null or s.lease_until<=now()
  or coalesce(s.cursor->'discoveryInFlight','[]'::jsonb)<>'[]'::jsonb
  or coalesce(s.cursor->'discoveryInFlightEventId','null'::jsonb)<>'null'::jsonb
  or coalesce(s.cursor->'discoveryUncertainOutcomes','[]'::jsonb)<>'[]'::jsonb
  or coalesce(s.cursor->'discoveryReconciliationReason','null'::jsonb)<>'null'::jsonb
  or (s.cursor->'discoverySourceOnlyOperation' is not null and s.cursor->'discoverySourceOnlyOperation'->>'status' is distinct from 'checkpointed')
  or jsonb_typeof(s.cursor->'discoveryContinuations') is distinct from 'object' then raise exception 'review consumption lease or in-flight fence mismatch'; end if;
 hold:=s.cursor->'discoveryCapacityHold';
 select * into hold_event from app_events where id=(hold->>'operationId')::uuid;
 if not found or hold_event.kind is distinct from 'federal.discovery.capacity_hold' or hold_event.entity_id is distinct from 'federal-discovery'
  or hold_event.meta->'hold' is distinct from hold or hold->>'status' is distinct from 'held'
  or jsonb_typeof(hold->'companyIds') is distinct from 'array' or jsonb_array_length(hold->'companyIds') not between 1 and 4 then raise exception 'original capacity hold proof missing'; end if;
 mode:=s.cursor->'discoveryManualSourceOnly';
 existing_mode:=mode is not null;
 if mode is null then
  mode:=jsonb_build_object('version',1,'status','manual_source_only','holdOperationId',hold->'operationId',
   'establishedEventId',operation_id,'manualRunCutoff',manual_cutoff,'retiredCapacityCompanyIds','[]'::jsonb);
 elsif jsonb_typeof(mode) is distinct from 'object' or (select count(*) from jsonb_object_keys(mode))<>6
  or exists(select 1 from jsonb_object_keys(mode) k where k not in('version','status','holdOperationId','establishedEventId','manualRunCutoff','retiredCapacityCompanyIds'))
  or mode->'version' is distinct from '1'::jsonb or mode->>'status' is distinct from 'manual_source_only'
  or mode->'holdOperationId' is distinct from hold->'operationId' or mode->>'manualRunCutoff' is distinct from p_request->>'manualRunCutoff'
  or jsonb_typeof(mode->'retiredCapacityCompanyIds') is distinct from 'array' then raise exception 'manual source-only mode mismatch'; end if;
 retired_ids:=mode->'retiredCapacityCompanyIds';
 if jsonb_array_length(retired_ids)>jsonb_array_length(hold->'companyIds')
  or (select count(distinct x) from jsonb_array_elements(retired_ids) x)<>jsonb_array_length(retired_ids)
  or exists(select 1 from jsonb_array_elements(retired_ids) x where not (hold->'companyIds' @> jsonb_build_array(x)))
  or exists(select 1 from jsonb_array_elements_text(hold->'companyIds') x where not (retired_ids @> to_jsonb(array[x])) and not(s.cursor->'discoveryContinuations' ? x))
  or exists(select 1 from jsonb_array_elements_text(retired_ids) x where s.cursor->'discoveryContinuations' ? x)
  or (select count(*) from jsonb_object_keys(s.cursor->'discoveryContinuations'))>1000+jsonb_array_length(hold->'companyIds')-jsonb_array_length(retired_ids) then raise exception 'manual capacity invariant mismatch'; end if;
 if existing_mode then
  if not exists(select 1 from app_events x where x.id=(mode->>'establishedEventId')::uuid
   and x.module='headhunter' and x.kind='federal.discovery.capture_review_consumed' and x.entity_type='cron' and x.entity_id='federal-discovery'
   and x.meta->'originalCapacityHold'=hold and x.meta->'manualSourceOnly'->>'establishedEventId'=x.id::text
   and x.meta->'manualSourceOnly'->>'manualRunCutoff'=p_request->>'manualRunCutoff') then raise exception 'manual mode establishment event missing'; end if;
  for key in select jsonb_array_elements_text(retired_ids) loop
   if not exists(select 1 from app_events x where x.module='headhunter' and x.kind='federal.discovery.capture_review_consumed'
    and x.entity_type='cron' and x.entity_id='federal-discovery' and x.meta->>'companyId'=key and x.meta->'queryRetired'='true'::jsonb
    and x.meta->'originalCapacityHold'=hold and x.meta->'request'->>'manualRunCutoff'=p_request->>'manualRunCutoff'
    and x.meta->'manualSourceOnly'->>'establishedEventId'=mode->>'establishedEventId') then raise exception 'retired capacity review event missing'; end if;
  end loop;
 end if;
 current_cont:=s.cursor->'discoveryContinuations'->company_id::text;
 if current_cont is null or encode(digest(convert_to(current_cont::text,'UTF8'),'sha256'),'hex') is distinct from p_request->>'expectedContinuationSha256'
  or s.cursor->'discoveryReadbackHold'->'companyIds' @> to_jsonb(array[company_id::text])
  or exists(select 1 from jsonb_array_elements(coalesce(s.cursor->'discoveryStrategyTimeouts','[]')) r where r->>'companyId'=company_id::text and (r->>'heldAt' is not null or coalesce(r->>'timeoutCount','0')<>'0'))
  or exists(select 1 from jsonb_array_elements(coalesce(s.cursor->'retryQueue','[]')) r where r->>'companyId'=company_id::text)
  or exists(select 1 from jsonb_array_elements(coalesce(s.cursor->'deadLetters','[]')) r where r->>'companyId'=company_id::text and r->>'resolvedAt' is null) then raise exception 'exact continuation changed or has unresolved debt'; end if;
 select * into j from intelligence_jobs where id=(p_request->>'jobId')::uuid for update;
 if not found or j.status is distinct from 'complete' or j.kind is distinct from 'interpret' or j.finished_at is null
  or j.lease_token is not null or j.lease_until is not null or j.codex_news_request_id is null then raise exception 'completed canonical job required'; end if;
 select * into o from intelligence_observations where id=j.observation_id for share;
 select * into c from companies where id=company_id for share;
 if c.id is null or o.company_id is distinct from company_id or 'tam_duplicate'=any(coalesce(c.lists,'{}'))
  or not(c.tal_claimed is true or (coalesce(c.lists,'{}'::text[]) @> array['netsuite_tam']::text[] and c.status is distinct from 'removed_from_tam'))
  or not intelligence_codex_empty_government_capture(to_jsonb(o),to_jsonb(c)) then raise exception 'exact eligible original capture required'; end if;
 -- Completion froze the reviewed snapshot. Incidental later company fields
 -- cannot invalidate that receipt; current exact identity/source is checked above.
 review:=j.result->'codexNews'; source_receipt:=review->'receipt';
 scope:=review->'analysis'->'governmentCapture';
 units:=length(o.evidence_text)+length(regexp_replace(o.evidence_text,U&'[\0001-\FFFF]','','g'));
 if review->>'snapshotHash' is distinct from p_request->>'snapshotHash' or review->>'decisionHash' is distinct from p_request->>'decisionHash'
  or review->>'requestId' is distinct from j.codex_news_request_id::text
  or review->'analysis'->>'disposition' is distinct from 'no_signal' or review->'independentReview'->'approved' is distinct from 'true'::jsonb
  or review->'analysis'->'reader'->>'taskId' is distinct from review->>'actor'
  or review->'independentReview'->'reviewer'->>'taskId'=review->>'actor'
  or length(coalesce(review->'independentReview'->'reviewer'->>'taskId',''))<3
  or review->'independentReview'->>'decisionHash' is distinct from p_request->>'decisionHash'
  or review->'independentReview'->'governmentCapture' is distinct from scope
  or scope is distinct from jsonb_build_object('version','government-empty-search-v1','completionScope','source_capture','historyComplete',false,
   'recipientIdentityVerified',false,'requestIdentityConfirmed',true,'fullProvenanceRead',true,'searchEndDate',o.metadata->>'searchEndDate',
   'collection',o.metadata->'continuationBefore'->>'collection','requestSha256',o.metadata->>'requestSha256','retainedJsonSha256',o.metadata->>'retainedJsonSha256')
  or scope->>'completionScope' is distinct from 'source_capture' or scope->'historyComplete' is distinct from 'false'::jsonb
  or scope->'recipientIdentityVerified' is distinct from 'false'::jsonb or scope->'requestIdentityConfirmed' is distinct from 'true'::jsonb
  or scope->'fullProvenanceRead' is distinct from 'true'::jsonb
  or source_receipt->>'eventId' is distinct from p_request->>'finishEventId'
  or source_receipt->>'jobId' is distinct from j.id::text or source_receipt->>'observationId' is distinct from o.id::text
  or source_receipt->>'companyId' is distinct from company_id::text or source_receipt->>'snapshotHash' is distinct from p_request->>'snapshotHash'
  or source_receipt->>'decisionHash' is distinct from p_request->>'decisionHash' or source_receipt->>'disposition' is distinct from 'no_signal'
  or source_receipt->>'sourceKind' is distinct from 'government' or source_receipt->>'requestSha256' is distinct from o.metadata->>'requestSha256'
  or source_receipt->>'retainedJsonSha256' is distinct from o.metadata->>'retainedJsonSha256' or source_receipt->>'searchEndDate' is distinct from o.metadata->>'searchEndDate'
  or source_receipt->'triggerId' is distinct from 'null'::jsonb or source_receipt->'newTrigger' is distinct from 'false'::jsonb
  or source_receipt->>'completionScope' is distinct from 'source_capture' or source_receipt->'historyComplete' is distinct from 'false'::jsonb
  or source_receipt->'recipientIdentityVerified' is distinct from 'false'::jsonb then raise exception 'exact independent review receipt mismatch'; end if;
 foreach key in array array['reader','reviewer'] loop
  capture:=case when key='reader' then review->'analysis'->key else review->'independentReview'->key end;
  if capture->>'snapshotHash' is distinct from p_request->>'snapshotHash' or capture->'fullTextRead' is distinct from 'true'::jsonb
   or capture->'readStart' is distinct from '0'::jsonb or capture->'readEnd' is distinct from to_jsonb(units) then raise exception 'full independent source reads required'; end if;
 end loop;
 select * into finish_event from app_events where id=(p_request->>'finishEventId')::uuid;
 if not found or finish_event.module is distinct from 'headhunter' or finish_event.kind is distinct from 'intelligence.codex_news_reviewed'
  or finish_event.entity_type is distinct from 'intelligence_jobs' or finish_event.entity_id is distinct from j.id::text
  or finish_event.meta is distinct from source_receipt-'eventId'-'newTrigger'-'completedAt' then raise exception 'exact canonical finish event missing'; end if;
 if exists(select 1 from app_events where kind='federal.discovery.capture_review_consumed' and meta->'request'->>'jobId'=j.id::text) then raise exception 'review already consumed under a different operation'; end if;
 prior:=o.metadata->'continuationBefore'; terminal:=prior->>'collection'='idvs';
 expected_cont:=case when terminal then prior else prior||jsonb_build_object('collection','idvs','targetIndex',0,'page',1,'lastPageHash',null,'searchAfter',null) end;
 capture:=current_cont->'sourceCapture';
 if current_cont-'sourceCapture' is distinct from expected_cont
  or (select count(*) from jsonb_object_keys(capture))<>8 or capture->'version' is distinct from '1'::jsonb
  or capture->>'stage' is distinct from 'search' or capture->>'observationId' is distinct from o.id::text
  or capture->>'requestSha256' is distinct from o.metadata->>'requestSha256'
  or capture->>'retainedJsonSha256' is distinct from o.metadata->>'retainedJsonSha256'
  or (capture->>'capturedAt')::timestamptz is distinct from o.observed_at
  or capture->>'status' is distinct from (case when terminal then 'held' else 'pending' end)
  or (capture->>'reason' is distinct from (case when terminal then 'search_window_captured_awaiting_independent_review' else 'search_page_captured_continuation_pending' end)
   and not (terminal and capture->>'reason'='retained_source_recovered_awaiting_independent_review' and exists(
    select 1 from app_events x cross join lateral jsonb_array_elements(x.meta->'outcomes') outcome
    where x.module='headhunter' and x.kind='federal.discovery.source_only_reconciled' and x.entity_type='cron' and x.entity_id='federal-discovery'
     and x.meta->'sourceRequests'='0'::jsonb and x.meta->'analysisComplete'='false'::jsonb and x.meta->'historyComplete'='false'::jsonb
     and x.meta->'request'->'originalRequest'->>'operationId'=o.metadata->>'operationId'
     and x.meta->'request'->'originalRequest'->>'holdOperationId'=hold->>'operationId'
     and x.meta->'request'->'retainedSource'=jsonb_build_object('observationId',o.id,'jobId',j.id,'sourceKey',o.source_key,
      'requestSha256',o.metadata->>'requestSha256','retainedJsonSha256',o.metadata->>'retainedJsonSha256')
     and outcome->>'companyId'=company_id::text and outcome->>'jobId'=j.id::text and outcome->>'observationId'=o.id::text
     and outcome->'reusedCapture'='true'::jsonb and outcome->'sourceCaptured'='true'::jsonb
     and outcome->'continuation'=current_cont)))
  or (prior->>'searchEndDate')::date>manual_cutoff then raise exception 'captured position does not match exact collector transition'; end if;
 next_map:=s.cursor->'discoveryContinuations';
 if terminal then
  next_map:=next_map-company_id::text;
  if hold->'companyIds' @> to_jsonb(array[company_id::text]) then retired_ids:=retired_ids||to_jsonb(array[company_id::text]); end if;
 else next_map:=jsonb_set(next_map,array[company_id::text],current_cont-'sourceCapture'); end if;
 mode:=mode||jsonb_build_object('retiredCapacityCompanyIds',retired_ids);
 next_cursor:=s.cursor||jsonb_build_object('discoveryContinuations',next_map,'discoveryManualSourceOnly',mode);
 select to_jsonb(x) into prior_coverage from company_federal_source_coverage x where x.company_id=(p_request->>'companyId')::uuid and x.source='federal-discovery' for update;
 receipt:=jsonb_build_object('eventId',operation_id,'source','federal-discovery','request',p_request,'companyId',company_id,
  'priorContinuation',current_cont,'nextContinuation',case when terminal then null else current_cont-'sourceCapture' end,
  'queryRetired',terminal,'sourceRequests',0,'attemptsCredited',0,'triggers',0,'completionScope','source_capture',
  'companyComplete',false,'historyComplete',false,'recipientIdentityVerified',false,'coverageVerified',false,
  'sourceReceipt',source_receipt,'originalCapacityHold',hold,'manualSourceOnly',mode,'priorCoverage',prior_coverage,
  'beforeCursorSha256',encode(digest(convert_to(s.cursor::text,'UTF8'),'sha256'),'hex'),
  'afterCursorSha256',encode(digest(convert_to(next_cursor::text,'UTF8'),'sha256'),'hex'));
 -- Each write is in this one transaction; any missing event/coverage write rolls back the cursor.
 update public_growth_sweep_state set cursor=next_cursor,updated_at=now() where source='federal-discovery';
 insert into company_federal_source_coverage(company_id,source,status,scope,searched_from,searched_through,last_attempted_at,detail)
 values(company_id,'federal-discovery','partial','Reviewed empty frozen name-search capture; aliases, contracts and history are not certified','2007-10-01',(prior->>'searchEndDate')::date,o.observed_at,
  jsonb_build_object('lastReviewedSourceCapture',jsonb_build_object('eventId',operation_id,'completionScope','source_capture','historyComplete',false,'recipientIdentityVerified',false,'queryRetired',terminal)))
 on conflict on constraint company_federal_source_coverage_pkey do update set
  detail=company_federal_source_coverage.detail||excluded.detail;
 insert into app_events(id,module,kind,entity_type,entity_id,summary,meta) values(operation_id,'headhunter','federal.discovery.capture_review_consumed','cron','federal-discovery',
  'Consumed one completed original capture review; company and history remain incomplete',receipt);
 return receipt;
end $$;

-- Canonical claimed TAL remains eligible even when outside or removed from TAM.
create or replace function public.list_federal_discovery_tam_batch(p_limit integer,p_after_company_id uuid default null)
returns setof public.companies language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_limit is null or p_limit<1 or p_limit>21 then raise exception 'federal discovery limit must be between 1 and 21'; end if;
 return query select c.* from companies c where (p_after_company_id is null or c.id>p_after_company_id)
  and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
  and (c.tal_claimed is true or (coalesce(c.lists,'{}'::text[]) @> array['netsuite_tam']::text[] and c.status is distinct from 'removed_from_tam'))
  and not exists(select 1 from company_government_matches m join government_entities e on e.id=m.government_entity_id
   where m.company_id=c.id and m.match_status='verified' and (e.usaspending_recipient_id is not null or exists(select 1 from federal_awards a where a.government_entity_id=e.id)))
 order by c.id limit p_limit;
end $$;
revoke all on function public.inspect_federal_reviewed_capture(uuid) from public,anon,authenticated;
revoke all on function public.consume_federal_reviewed_capture(jsonb,uuid) from public,anon,authenticated;
revoke all on function public.list_federal_discovery_tam_batch(integer,uuid) from public,anon,authenticated;
grant execute on function public.inspect_federal_reviewed_capture(uuid),public.consume_federal_reviewed_capture(jsonb,uuid),public.list_federal_discovery_tam_batch(integer,uuid) to service_role;
notify pgrst,'reload schema';
commit;
