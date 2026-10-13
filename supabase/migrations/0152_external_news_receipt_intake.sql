-- Import already executed public discovery into existing research ledgers.
-- No new queue, search, model, publisher, membership or grade path.
begin;
alter table public.intelligence_external_research_queries add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.intelligence_external_research_queries drop constraint if exists intelligence_external_research_queries_purpose_check;
alter table public.intelligence_external_research_queries add constraint intelligence_external_research_queries_purpose_check
  check(purpose in ('operating_gaps','event_followup','identity_company_family','news','oracle_partnership'));
-- One actual provider call cannot acquire collection credit through new UUIDs.
create unique index if not exists intelligence_external_news_call_once
  on public.app_events ((meta#>>'{request,callId}')) where kind='intelligence.external_news.import';

create or replace function public.intelligence_external_news_intake(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare
  op uuid; company_id_arg uuid; request_hash text; existing app_events%rowtype; discovery app_events%rowtype;
  co companies%rowtype; q intelligence_external_research_queries%rowtype; attempt intelligence_research_attempts%rowtype;
  item jsonb; obs intelligence_observations%rowtype; prepared jsonb; result jsonb; receipt jsonb; meta jsonb;
  v_query_hash text; source_url_arg text; source_key_arg text; claims jsonb; lease uuid; n integer; identity jsonb;
  publication timestamptz; publication_count integer;
begin
  if p_action not in ('status','import','begin_capture','finish_capture') or jsonb_typeof(p_payload)<>'object'
    or length(p_payload::text)>300000 then raise exception 'invalid_external_intake'; end if;
  op:=(p_payload->>'requestId')::uuid;
  if op is null then raise exception 'exact_intake_id_required'; end if;
  if p_action='status' then
    select * into existing from app_events where id=op and kind in ('intelligence.external_news.import','intelligence.external_news.capture');
    return case when found then existing.meta else null end;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('external-news-operation:'||op::text,0));
  select * into existing from app_events where id=op for update;
  if p_action<>'finish_capture' then
    request_hash:=encode(digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex');
    if existing.id is not null then
      if existing.kind<>(case when p_action='import' then 'intelligence.external_news.import' else 'intelligence.external_news.capture' end)
        or existing.meta->>'requestHash' is distinct from request_hash then raise exception 'external_intake_request_conflict'; end if;
      return case when p_action='begin_capture' then jsonb_build_object('fetch',false,'operation',existing.meta) else existing.meta end;
    end if;
    if p_payload->>'sourceOnly' is distinct from 'true' or coalesce(p_payload->>'taskId','')!~'^[a-zA-Z0-9_:/.-]{3,180}$'
      then raise exception 'invalid_source_only_actor'; end if;
    company_id_arg:=(p_payload->>'companyId')::uuid;
  else
    if existing.id is null or existing.kind<>'intelligence.external_news.capture' then raise exception 'capture_operation_missing'; end if;
    if existing.meta->>'state'<>'capturing' then raise exception 'capture_already_terminal_read_status'; end if;
    if existing.meta->>'lease' is distinct from p_payload->>'lease' then raise exception 'capture_lease_mismatch'; end if;
    company_id_arg:=(existing.meta->>'companyId')::uuid;
  end if;
  if not coalesce((select enabled from intelligence_config where id=1),false) then raise exception 'intelligence_disabled'; end if;
  select * into co from companies where id=company_id_arg for share;
  if not found or 'tam_duplicate'=any(coalesce(co.lists,'{}'::text[])) or not
    (co.tal_claimed is true or (coalesce(co.lists,'{}'::text[]) @> array['netsuite_tam']::text[] and co.status is distinct from 'removed_from_tam'))
    then raise exception 'external_account_not_in_scope'; end if;
  identity:=jsonb_build_object('name',co.name,'domain',co.domain,'netsuiteInternalId',co.netsuite_internal_id);
  if identity is distinct from (case when p_action='finish_capture' then existing.meta->'request'->'expectedIdentity' else p_payload->'expectedIdentity' end)
    then raise exception 'external_account_identity_changed'; end if;

  if p_action='import' then
    v_query_hash:=p_payload->>'queryHash'; n:=jsonb_array_length(p_payload->'items');
    if coalesce(v_query_hash,'')!~'^[a-f0-9]{64}$' or coalesce(p_payload->>'lane','') not in ('news','oracle_partnership')
      or coalesce(p_payload->>'endpoint','') not in ('tinyfish.web.search','tinyfish.web.search.news')
      or coalesce(p_payload->>'outcome','') not in ('success','empty') or n is null or n not between 0 and 24
      or coalesce(p_payload->>'callId','')='' or p_payload->>'retrievedAt' is null
      or encode(digest(convert_to(p_payload->>'providerRequest','UTF8'),'sha256'),'hex') is distinct from p_payload->>'requestSha256'
      or encode(digest(convert_to(p_payload->>'providerResponse','UTF8'),'sha256'),'hex') is distinct from p_payload->>'responseSha256'
      or (n=0) is distinct from (p_payload->>'outcome'='empty') or (p_payload->>'retrievedAt')::timestamptz>now()
      or coalesce(p_payload->>'query','')='' then raise exception 'invalid_external_query_receipt'; end if;
    perform pg_advisory_xact_lock(hashtextextended('external-research:'||company_id_arg::text,0));
    select * into q from intelligence_external_research_queries where company_id=company_id_arg and query_hash=v_query_hash for update;
    if found and (q.lease_token is not null or q.metadata->>'provider' is distinct from 'tinyfish'
      or q.query is distinct from p_payload->>'query' or q.purpose is distinct from p_payload->>'lane'
      or (q.metadata->>'retrievedAt')::timestamptz>(p_payload->>'retrievedAt')::timestamptz)
      then raise exception 'external_query_existing_state_conflict'; end if;
    for item in select value from jsonb_array_elements(p_payload->'items') loop
      if length(item->>'canonicalUrl')>2048 or item->>'canonicalUrl'!~'^https?://' then raise exception 'invalid_external_source_url'; end if;
      if item->>'captureEligible' is distinct from 'true' then continue; end if;
      insert into intelligence_research_sources(company_id,source_url,title,discovered_from,discovered_at,metadata)
      values(company_id_arg,item->>'canonicalUrl',item->>'title','tinyfish:'||(p_payload->>'endpoint'),(p_payload->>'retrievedAt')::timestamptz,
        jsonb_build_object('researchOrigin','external_search','researchPurpose',p_payload->>'lane','query',p_payload->>'query',
          'queryHash',v_query_hash,'discoveryOperationId',op,'provider','tinyfish','discoveredAt',p_payload->>'retrievedAt',
          'itemSha256',item->>'itemSha256','providerRawDate',item->'date','sourceOnly',true,
          'newsItem',jsonb_build_object('source_url',item->>'canonicalUrl','raw_excerpt',item->>'title',
            'feed_excerpt',item->'snippet','signal_date',null,'source_name','TinyFish discovery')))
      on conflict(company_id,source_url) do nothing; -- Never replace prior source provenance.
    end loop;
    meta:=jsonb_build_object('provider','tinyfish','operationId',op,'retrievedAt',p_payload->>'retrievedAt',
      'requestSha256',p_payload->>'requestSha256','responseSha256',p_payload->>'responseSha256',
      'pagination','unknown','coverage','query_page_only','analysisCompleted',false,'accountCompleted',false);
    insert into intelligence_external_research_queries(company_id,query_hash,query,purpose,last_attempt_at,last_outcome,source_count,next_attempt_at,metadata)
    values(company_id_arg,v_query_hash,p_payload->>'query',p_payload->>'lane',(p_payload->>'retrievedAt')::timestamptz,
      p_payload->>'outcome',n,'infinity',meta)
    on conflict(company_id,query_hash) do update set last_attempt_at=excluded.last_attempt_at,last_outcome=excluded.last_outcome,
      source_count=excluded.source_count,next_attempt_at=excluded.next_attempt_at,metadata=excluded.metadata;
    source_key_arg:='news:tinyfish:'||(p_payload->>'lane')||':'||v_query_hash;
    insert into intelligence_source_state(company_id,source_key,cursor,complete,last_attempt_at,last_success_at,coverage_status,error_details)
    values(company_id_arg,source_key_arg,meta,false,(p_payload->>'retrievedAt')::timestamptz,(p_payload->>'retrievedAt')::timestamptz,
      case when n=0 then 'empty' else 'partial' end,jsonb_build_object('queryPageOnly',true,'discovered',n,'pagination','unknown'))
    on conflict(company_id,source_key) do update set cursor=excluded.cursor,complete=false,last_attempt_at=excluded.last_attempt_at,
      last_success_at=excluded.last_success_at,coverage_status=excluded.coverage_status,error_details=excluded.error_details;
    receipt:=jsonb_build_object('operationId',op,'requestHash',request_hash,'companyId',company_id_arg,'state','imported',
      'queryHash',v_query_hash,'sourceCount',n,'sourceOnly',true,'outcome',p_payload->>'outcome','request',p_payload,
      'capturableResultCount',(select count(*) from jsonb_array_elements(p_payload->'items') where value->>'captureEligible'='true'),
      'analysisCompleted',false,'accountCompleted',false,'coverage','query_page_only','pagination','unknown',
      'collection',jsonb_build_object('requestedCompanyIds',jsonb_build_array(company_id_arg),
        'outcomes',jsonb_build_array(jsonb_build_object('companyId',company_id_arg,'admission','attempted','collectorOutcome',case when n=0 then 'succeeded' else 'partial' end)),
        'coverage','reservation_and_collector_outcomes_only','analysisCompleted',false));
    insert into app_events(id,module,kind,entity_type,entity_id,summary,meta)
      values(op,'headhunter','intelligence.external_news.import','companies',company_id_arg::text,'Imported bounded external discovery receipt',receipt);
    return receipt;
  end if;

  if p_action='begin_capture' then
    select * into discovery from app_events where id=(p_payload->>'discoveryId')::uuid and kind='intelligence.external_news.import';
    if not found or discovery.meta->>'companyId' is distinct from company_id_arg::text then raise exception 'external_discovery_missing'; end if;
    select value into item from jsonb_array_elements(discovery.meta->'request'->'items') where (value->>'position')::integer=(p_payload->>'position')::integer;
    if item is null then raise exception 'exact_discovery_item_missing'; end if;
    source_url_arg:=item->>'canonicalUrl';
    perform pg_advisory_xact_lock(hashtextextended('external-news-url:'||company_id_arg::text||':'||source_url_arg,0));
    receipt:=jsonb_build_object('operationId',op,'requestHash',request_hash,'request',p_payload,'companyId',company_id_arg,
      'discoveryId',discovery.id,'sourceUrl',source_url_arg,'item',item,'analysisCompleted',false,'accountCompleted',false);
    select * into obs from intelligence_observations where company_id=company_id_arg and source_url=source_url_arg and is_current order by observed_at desc,id limit 1;
    if item->>'captureEligible' is distinct from 'true' then
      receipt:=receipt||jsonb_build_object('state','held','reason','direct_original_url_required');
    elsif found then
      receipt:=receipt||jsonb_build_object('state','reused','observationId',obs.id,'feedbackExcluded',obs.feedback_excluded,
        'reason','existing_current_observation_preserved');
    else
      insert into intelligence_research_attempts(company_id,source_url) values(company_id_arg,source_url_arg) on conflict do nothing;
      select * into attempt from intelligence_research_attempts where company_id=company_id_arg and source_url=source_url_arg for update;
      if attempt.last_attempt_at is not null or attempt.lease_token is not null or attempt.outcome is not null or attempt.next_attempt_at>now() then
        receipt:=receipt||jsonb_build_object('state','held','reason','existing_source_attempt_preserved');
      else
        claims:=intelligence_research_claim(company_id_arg,array[source_url_arg]);
        if jsonb_array_length(claims)<>1 then raise exception 'external_source_not_reserved'; end if;
        lease:=(claims->0->>'lease_token')::uuid;
        receipt:=receipt||jsonb_build_object('state','capturing','lease',lease,
          'company',jsonb_build_object('id',co.id,'name',co.name,'domain',co.domain,'netsuite_internal_id',co.netsuite_internal_id,'subindustry',co.subindustry));
      end if;
    end if;
    -- This event and URL lease commit before any HTTP request. Even after lease
    -- expiry, this operation can only be read; begin never re-dispatches it.
    insert into app_events(id,module,kind,entity_type,entity_id,summary,meta)
      values(op,'headhunter','intelligence.external_news.capture','companies',company_id_arg::text,'External original capture operation',receipt);
    return jsonb_build_object('fetch',receipt->>'state'='capturing','operation',receipt,'item',item,'lease',lease,'company',receipt->'company');
  end if;

  source_url_arg:=existing.meta->>'sourceUrl'; lease:=(p_payload->>'lease')::uuid;
  select * into attempt from intelligence_research_attempts where company_id=company_id_arg and source_url=source_url_arg for update;
  if not found or attempt.lease_token is distinct from lease or attempt.lease_until is null or attempt.lease_until<=now() then raise exception 'external_capture_lease_expired'; end if;
  prepared:=p_payload->'observation';
  if prepared is not null and prepared<>'null'::jsonb then
    if prepared->'metadata'->>'externalCaptureId' is distinct from op::text or prepared->'metadata'->>'articleBodyAvailable' is distinct from 'true'
      or prepared->'metadata'->>'evidenceKind' is distinct from 'article_body' or prepared->'metadata'->>'textTruncated' is distinct from 'false'
      or coalesce(length(prepared->>'text'),0) not between 160 and 48000 then raise exception 'incomplete_external_original'; end if;
    select count(distinct value->>'value'),min((value->>'value')::timestamptz) into publication_count,publication
      from jsonb_array_elements(coalesce(prepared->'metadata'->'sourceDates','[]'::jsonb)) where value->>'kind'='published';
    if publication_count<>1 or publication>now() then publication:=null; end if;
    if (prepared->>'eventDate')::timestamptz is distinct from publication or prepared->'metadata'->>'eventDateBasis'
      is distinct from (case when publication is null then 'unknown' else 'page_publication' end) then raise exception 'external_original_date_mismatch'; end if;
    -- Serialize with canonical collectors on the resolved original. A native
    -- capture arriving during HTTP must be reused, not reset or superseded.
    perform pg_advisory_xact_lock(hashtextextended(company_id_arg::text||(prepared->>'sourceKey'),0));
    select * into obs from intelligence_observations where company_id=company_id_arg and is_current
      and (source_key=prepared->>'sourceKey' or source_url in (source_url_arg,prepared->>'url')) order by observed_at desc,id limit 1;
    if found then
      result:=jsonb_build_object('id',obs.id,'queued',false,'reused',true,'feedbackExcluded',obs.feedback_excluded);
    else
      -- Canonical observe retains its existing provenance/version/job rules.
      result:=intelligence_observe(p_company=>company_id_arg,p_source_key=>prepared->>'sourceKey',p_source_kind=>'news',p_url=>prepared->>'url',
        p_title=>left(existing.meta->'item'->>'title',500),p_text=>prepared->>'text',p_hash=>prepared->>'contentHash',
        p_event_date=>publication,p_observed_at=>(prepared->>'observedAt')::timestamptz,p_metadata=>prepared->'metadata',
        p_sections=>prepared->'sections',p_version=>p_payload->>'version');
    end if;
    if result->>'id' is null or result->>'disabled'='true' then raise exception 'external_observation_not_persisted'; end if;
    if not intelligence_research_finish(company_id_arg,source_url_arg,lease,case when (result->>'queued')::boolean then 'queued' else 'unchanged' end)
      then raise exception 'external_source_finish_unconfirmed'; end if;
    receipt:=existing.meta||jsonb_build_object('state',case when result->>'reused'='true' then 'reused' else 'captured' end,
      'lease',null,'observationId',result->>'id','observationResult',result);
  else
    if not intelligence_research_finish(company_id_arg,source_url_arg,lease,'source_failed') then raise exception 'external_source_finish_unconfirmed'; end if;
    update intelligence_research_attempts set next_attempt_at='infinity' where company_id=company_id_arg and source_url=source_url_arg;
    receipt:=existing.meta||jsonb_build_object('state','held','lease',null,'reason',coalesce(p_payload->>'failure','original_unavailable'));
  end if;
  update app_events set meta=receipt where id=op;
  return receipt;
end $$;
revoke all on function public.intelligence_external_news_intake(text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_external_news_intake(text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
