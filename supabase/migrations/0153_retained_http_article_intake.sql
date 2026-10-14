-- Extend the existing operation ledger/RPC; no provider fetch, queue or publisher.
-- Patch exact anchors so every TinyFish branch remains unchanged.
begin;
do $migration$
declare definition text; before_text text; after_text text; pair text[];
begin
  select pg_get_functiondef('public.intelligence_external_news_intake(text,jsonb)'::regprocedure) into definition;
  if position('-- retained-http-v1' in definition)>0 then return; end if;
  foreach pair slice 1 in array array[
    array[$a$('status','import','begin_capture','finish_capture')$a$,$a$('status','import','begin_capture','finish_capture','import_retained_http')$a$],
    array[$a$kind in ('intelligence.external_news.import','intelligence.external_news.capture')$a$,$a$kind in ('intelligence.external_news.import','intelligence.external_news.capture','intelligence.external_news.retained_http')$a$],
    array[$a$case when p_action='import' then 'intelligence.external_news.import' else 'intelligence.external_news.capture' end$a$,
      $a$case when p_action='import' then 'intelligence.external_news.import' when p_action='import_retained_http' then 'intelligence.external_news.retained_http' else 'intelligence.external_news.capture' end$a$]
  ] loop
    if (length(definition)-length(replace(definition,pair[1],'')))/length(pair[1])<>1 then
      raise exception 'Unexpected external intake definition; review required';
    end if;
    definition:=replace(definition,pair[1],pair[2]);
  end loop;
  before_text:=$anchor$  if p_action='import' then$anchor$;
  after_text:=$branch$  -- retained-http-v1: authenticated saved bytes, never a server-fetch assertion.
  if p_action='import_retained_http' then
    prepared:=p_payload->'observation'; item:=p_payload->'receipt';
    source_url_arg:=prepared->>'url'; source_key_arg:=prepared->>'sourceKey';
    if p_payload->>'action' is distinct from 'import_retained_http'
      or item->>'sourceKind' is distinct from 'retained_http'
      or item->>'attestorTaskId' is distinct from p_payload->>'taskId'
      or item->>'status' is distinct from '200' or item->>'redirectCount' is distinct from '0'
      or item->>'completeResponse' is distinct from 'true'
      or item->>'requestedUrl' is distinct from item->>'finalUrl'
      or source_url_arg is distinct from item->>'requestedUrl'
      or coalesce(item->>'requestedUrl','')!~'^https?://'
      or coalesce(item->>'bodySha256','')!~'^[a-f0-9]{64}$'
      or octet_length(decode(item->>'bodyBase64','base64')) is distinct from (item->>'bodyBytes')::integer
      or (item->>'bodyBytes')::integer not between 1 and 180000
      or encode(digest(decode(item->>'bodyBase64','base64'),'sha256'),'hex') is distinct from item->>'bodySha256'
      or item->>'fetchedAt' is null or (item->>'fetchedAt')::timestamptz>now()
      or (prepared->>'observedAt')::timestamptz is distinct from (item->>'fetchedAt')::timestamptz
      or coalesce(source_key_arg,'')!~'^[a-f0-9]{64}$'
      or source_key_arg is distinct from encode(digest(convert_to(source_url_arg,'UTF8'),'sha256'),'hex')
      or prepared->'metadata'->'retainedHttp'->>'operationId' is distinct from op::text
      or prepared->'metadata'->'retainedHttp'->>'priorObservationId' is distinct from p_payload->>'observationId'
      or prepared->'metadata'->'retainedHttp'->>'expectedContentHash' is distinct from p_payload->>'expectedContentHash'
      or ((prepared->'metadata'->'retainedHttp')-'operationId'-'priorObservationId'-'expectedContentHash'-'networkIndependentlyVerified'-'rawBodyLocation')
        is distinct from (item-'bodyBase64')
      or prepared->'metadata'->'retainedHttp'->>'bodySha256' is distinct from item->>'bodySha256'
      or prepared->'metadata'->'retainedHttp'->>'networkIndependentlyVerified' is distinct from 'false'
      or prepared->'metadata'->>'articleBodyAvailable' is distinct from 'true'
      or prepared->'metadata'->>'evidenceKind' is distinct from 'article_body'
      or prepared->'metadata'->>'textTruncated' is distinct from 'false'
      or coalesce(length(prepared->>'text'),0) not between 160 and 24000
      or coalesce(length(p_payload->>'title'),0) not between 1 and 300
      or prepared->'metadata'->>'companyName' is distinct from co.name
      or prepared->'metadata'->>'companyDomain' is distinct from co.domain
      or p_payload->>'version' is distinct from 'evidence-v2'
      then raise exception 'invalid_retained_http_capture'; end if;
    -- Fatal UTF-8 decoding also rejects NUL/malformed byte sequences in SQL.
    perform convert_from(decode(item->>'bodyBase64','base64'),'UTF8');
    select count(distinct value->>'value'),min((value->>'value')::timestamptz) into publication_count,publication
      from jsonb_array_elements(coalesce(prepared->'metadata'->'sourceDates','[]'::jsonb)) where value->>'kind'='published';
    if publication_count<>1 or publication>(item->>'fetchedAt')::timestamptz then publication:=null; end if;
    if (prepared->>'eventDate')::timestamptz is distinct from publication or prepared->'metadata'->>'eventDateBasis'
      is distinct from (case when publication is null then 'unknown' else 'page_publication' end)
      then raise exception 'retained_http_date_mismatch'; end if;
    perform pg_advisory_xact_lock(hashtextextended(company_id_arg::text||source_key_arg,0));
    select * into obs from intelligence_observations where id=(p_payload->>'observationId')::uuid for update nowait;
    if not found or obs.company_id<>company_id_arg or obs.source_kind<>'news' or not obs.is_current
      or obs.source_url is distinct from source_url_arg or obs.source_key is distinct from source_key_arg
      or obs.content_hash is distinct from p_payload->>'expectedContentHash' or obs.feedback_excluded
      then raise exception 'retained_http_source_binding_changed'; end if;
    -- Canonical collectors share the source lock. Do not retire another current
    -- stream, or resurrect a reviewed historical version with matching bytes.
    if exists(select 1 from intelligence_observations o where o.company_id=company_id_arg and o.id<>obs.id
      and (o.source_key=source_key_arg or o.source_url=source_url_arg) and (o.is_current
        or o.content_hash=prepared->>'contentHash' or o.metadata->>'documentContentHash'=prepared->>'contentHash'))
      then raise exception 'retained_http_source_version_conflict'; end if;
    receipt:=jsonb_build_object('operationId',op,'requestHash',request_hash,'request',p_payload,'companyId',company_id_arg,
      'sourceUrl',source_url_arg,'priorObservationId',obs.id,'sourceOnly',true,'provider','retained_http',
      'attestorTaskId',item->>'attestorTaskId','networkIndependentlyVerified',false,
      'analysisCompleted',false,'accountCompleted',false);
    if obs.metadata->>'articleBodyAvailable'='true' and obs.metadata->>'evidenceKind'='article_body'
      and obs.metadata->>'textTruncated'='false' and obs.evidence_text=prepared->>'text'
      and obs.title=p_payload->>'title' and obs.event_date is not distinct from publication
      and intelligence_observation_context(obs.source_kind,obs.metadata)=intelligence_observation_context('news',prepared->'metadata') then
      -- Pure reuse may acknowledge a completed body; no result/lease is touched.
      receipt:=receipt||jsonb_build_object('state','reused','observationId',obs.id,'reason','identical_complete_original_preserved');
    else
      if (item->>'fetchedAt')::timestamptz<obs.observed_at then
        raise exception 'retained_http_capture_precedes_current_source';
      end if;
      if not (obs.metadata->>'articleBodyAvailable'='false' or obs.metadata->>'textTruncated'='true'
        or obs.metadata->>'sourceTruncated'='true') or obs.attributes is not null or obs.interpreted_at is not null
        then raise exception 'retained_http_not_unreviewed_incomplete_source'; end if;
      -- Lock exact source jobs before checking. NOWAIT avoids holding a source
      -- lock while waiting on an active reader; any conflict is a no-write stop.
      perform j.id from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
        where o.company_id=company_id_arg and (o.source_key=source_key_arg or o.source_url=source_url_arg)
        and j.kind='interpret' order by j.id for update of j nowait;
      if not exists(select 1 from intelligence_jobs where observation_id=obs.id and kind='interpret')
        or exists(select 1 from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
          where o.company_id=company_id_arg and (o.source_key=source_key_arg or o.source_url=source_url_arg) and j.kind='interpret'
          and (j.status<>'queued' or j.attempts<>0 or j.due_at>now() or j.lease_token is not null or j.lease_until is not null
            or j.codex_news_request_id is not null or j.result is not null or j.last_error is not null or j.finished_at is not null))
        or exists(select 1 from intelligence_observations o where o.company_id=company_id_arg
          and (o.source_key=source_key_arg or o.source_url=source_url_arg) and (o.feedback_excluded or o.attributes is not null or o.interpreted_at is not null))
        or exists(select 1 from intelligence_research_attempts where company_id=company_id_arg and source_url=source_url_arg and lease_token is not null)
        or exists(select 1 from app_events e where e.kind='intelligence.external_news.capture' and e.entity_id=company_id_arg::text
          and e.meta->>'sourceUrl'=source_url_arg and e.meta->>'state'='capturing')
        then raise exception 'retained_http_prior_work_requires_reconciliation'; end if;
      result:=intelligence_observe(p_company=>company_id_arg,p_source_key=>source_key_arg,p_source_kind=>'news',p_url=>source_url_arg,
        p_title=>p_payload->>'title',p_text=>prepared->>'text',p_hash=>prepared->>'contentHash',
        p_event_date=>publication,p_observed_at=>(item->>'fetchedAt')::timestamptz,p_metadata=>prepared->'metadata',
        p_sections=>prepared->'sections',p_version=>p_payload->>'version');
      if result->>'id' is null or result->>'disabled'='true' or result->>'id'=obs.id::text
        then raise exception 'retained_http_observation_not_persisted'; end if;
      receipt:=receipt||jsonb_build_object('state','captured','observationId',result->>'id','observationResult',result);
    end if;
    insert into app_events(id,module,kind,entity_type,entity_id,summary,meta)
      values(op,'headhunter','intelligence.external_news.retained_http','companies',company_id_arg::text,'Imported saved public HTTP article',receipt);
    return receipt;
  end if;

  if p_action='import' then$branch$;
  if (length(definition)-length(replace(definition,before_text,'')))/length(before_text)<>1 then
    raise exception 'Unexpected external intake import anchor; review required';
  end if;
  execute replace(definition,before_text,after_text);
end;
$migration$;
-- CREATE OR REPLACE preserves the existing service-role-only grants.
notify pgrst,'reload schema';
commit;
