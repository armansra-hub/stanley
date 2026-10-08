-- Preserve one exact, journaled no-write overflow wave without running discovery.
-- Existing lease functions, enrollment tables and publishers are unchanged.
create or replace function public.reconcile_federal_discovery_capacity_hold(p_request jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.public_growth_sweep_state%rowtype;
  j public.app_events%rowtype;
  e public.app_events%rowtype;
  operation_id uuid; journal_id uuid; ids jsonb; row jsonb; target jsonb; cont jsonb;
  prior_map jsonb; next_map jsonb; next_cursor jsonb; hold jsonb; receipt jsonb;
  prior_count integer; next_count integer; n integer; key text;
  stamp text := to_char(clock_timestamp() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if jsonb_typeof(p_request) is distinct from 'object' or octet_length(p_request::text)>8000
    or (select count(*) from jsonb_object_keys(p_request))<>8
    or exists(select 1 from jsonb_object_keys(p_request) k where k not in
      ('operationId','journalId','companyIds','expectedCursorMd5','expectedJournalMd5','evidenceSha256','readerTaskId','reviewerTaskId'))
    or exists(select 1 from jsonb_each(p_request) a where a.key<>'companyIds' and jsonb_typeof(a.value)<>'string')
    or coalesce(p_request->>'operationId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_request->>'journalId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or coalesce(p_request->>'expectedCursorMd5','') !~ '^[0-9a-f]{32}$'
    or coalesce(p_request->>'expectedJournalMd5','') !~ '^[0-9a-f]{32}$'
    or coalesce(p_request->>'evidenceSha256','') !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_request->'readerTaskId') is distinct from 'string'
    or jsonb_typeof(p_request->'reviewerTaskId') is distinct from 'string'
    or length(btrim(p_request->>'readerTaskId')) not between 1 and 200
    or length(btrim(p_request->>'reviewerTaskId')) not between 1 and 200
    or btrim(p_request->>'readerTaskId')=btrim(p_request->>'reviewerTaskId')
    or jsonb_typeof(p_request->'companyIds') is distinct from 'array' then
    raise exception 'invalid federal capacity reconciliation request';
  end if;
  operation_id := (p_request->>'operationId')::uuid; journal_id := (p_request->>'journalId')::uuid;
  ids := p_request->'companyIds';
  if operation_id=journal_id or jsonb_array_length(ids) not between 1 and 4
    or exists(select 1 from jsonb_array_elements(ids) x where jsonb_typeof(x)<>'string'
      or x#>>'{}' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    or (select count(distinct x) from jsonb_array_elements(ids) x)<>jsonb_array_length(ids) then
    raise exception 'invalid exact federal capacity scope';
  end if;
  select * into s from public.public_growth_sweep_state where source='federal-discovery' for update;
  if not found then raise exception 'federal discovery state missing'; end if;
  select * into e from public.app_events where id=operation_id;
  if found then
    -- Same operation may be read back after a lost response, never repurposed.
    if e.module is distinct from 'headhunter' or e.kind is distinct from 'federal.discovery.capacity_hold'
      or e.entity_type is distinct from 'cron' or e.entity_id is distinct from 'federal-discovery'
      or e.meta->'request' is distinct from p_request
      or e.meta->>'afterCursorMd5' is distinct from md5(s.cursor::text)
      or e.meta->'hold' is distinct from s.cursor->'discoveryCapacityHold' then
      raise exception 'federal capacity operation conflict';
    end if;
    return e.meta;
  end if;
  if s.lease_until>now() or (s.lease_token is not null and s.lease_until is null)
    or jsonb_typeof(s.cursor) is distinct from 'object'
    or md5(s.cursor::text) is distinct from p_request->>'expectedCursorMd5'
    or s.cursor->'discoveryInFlight' is distinct from ids
    or s.cursor->>'discoveryInFlightEventId' is distinct from journal_id::text
    or s.cursor ? 'discoveryCapacityHold'
    or s.cursor->'discoveryUncertainOutcomes' not in ('null'::jsonb,'[]'::jsonb)
    or s.cursor->'discoveryReconciliationReason' is not null and s.cursor->'discoveryReconciliationReason'<>'null'::jsonb
    or s.cursor->'discoveryLastJournalResume'->>'eventId'=journal_id::text
    or jsonb_typeof(s.cursor->'discoveryContinuations') is distinct from 'object'
    or jsonb_typeof(s.cursor->'retryQueue') is distinct from 'array'
    or jsonb_typeof(s.cursor->'deadLetters') is distinct from 'array'
    or jsonb_typeof(s.cursor->'discoveryAttemptsTotal') is distinct from 'number'
    or coalesce(s.cursor->>'discoveryAttemptsTotal','') !~ '^[0-9]+$'
    or coalesce(s.cursor->>'afterCompanyId','') !~ '^[0-9a-f-]{36}$' then
    raise exception 'federal capacity state compare-and-swap failed';
  end if;
  prior_map := s.cursor->'discoveryContinuations'; next_map := prior_map;
  select count(*) into prior_count from jsonb_object_keys(prior_map);
  if prior_count>1000 then raise exception 'federal capacity prior map already exceeds ordinary bound'; end if;
  select * into j from public.app_events where id=journal_id;
  if not found or j.module is distinct from 'headhunter' or j.kind is distinct from 'federal.discovery.attempts'
    or j.entity_type is distinct from 'cron' or j.meta->>'source' is distinct from 'federal-discovery'
    or md5(j.meta::text) is distinct from p_request->>'expectedJournalMd5'
    or j.meta->>'requestStrategy' is distinct from 'name-only-v1'
    or j.meta->'coverageVerified' is distinct from 'false'::jsonb
    or j.meta->'historyComplete' is distinct from 'false'::jsonb
    or j.meta->'newStrategyHeldCompanyIds' is distinct from '[]'::jsonb
    or jsonb_typeof(j.meta->'attemptedCompanies') is distinct from 'array'
    or jsonb_array_length(j.meta->'attemptedCompanies')<>jsonb_array_length(ids)
    or j.ts>now()
    or coalesce(j.meta->>'attemptedAt','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$'
    or j.meta->'unresolvedReadbackCompanyIds' is distinct from s.cursor->'discoveryReadbackHold'->'companyIds'
    or j.meta->'readbackHoldStatus' is distinct from s.cursor->'discoveryReadbackHold'->'status'
    or j.meta->'readbackHoldReason' is distinct from s.cursor->'discoveryReadbackHold'->'reason' then
    raise exception 'federal capacity exact journal mismatch';
  end if;
  if (j.meta->>'attemptedAt')::timestamptz>j.ts then raise exception 'federal capacity journal date mismatch'; end if;
  for n in 0..jsonb_array_length(ids)-1 loop
    key := ids->>n; row := j.meta->'attemptedCompanies'->n; cont := row->'continuation';
    if jsonb_typeof(row) is distinct from 'object' or row->>'companyId' is distinct from key
      or key<=s.cursor->>'afterCompanyId' or prior_map ? key
      or exists(select 1 from jsonb_array_elements(s.cursor->'retryQueue') r where r->>'companyId'=key)
      or exists(select 1 from jsonb_array_elements(s.cursor->'deadLetters') r where r->>'companyId'=key)
      or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(s.cursor->'lastDiscoveryOutcomes')='array'
        then s.cursor->'lastDiscoveryOutcomes' else '[]'::jsonb end) r where r->>'companyId'=key)
      or exists(select 1 from jsonb_object_keys(row) k where k not in ('companyId','status','reason','stage','sourceRequests',
        'elapsedMs','verified','historyComplete','exhaustive','httpStatus','mayHaveWritten','continuation','searchEndDate'))
      or row->>'status' is distinct from 'in_progress' or row->>'stage' is distinct from 'award_search'
      or row->>'reason' is distinct from 'searching_contract_vehicles'
      or row->'sourceRequests' is distinct from '1'::jsonb or row->'mayHaveWritten' is distinct from 'false'::jsonb
      or row->'verified' is distinct from 'false'::jsonb or row->'historyComplete' is distinct from 'false'::jsonb
      or row->'exhaustive' is distinct from 'false'::jsonb
      or jsonb_typeof(row->'elapsedMs') is distinct from 'number' or coalesce(row->>'elapsedMs','') !~ '^[0-9]+$'
      or row->'httpStatus' not in ('null'::jsonb,'200'::jsonb)
      or jsonb_typeof(cont) is distinct from 'object' or cont->'version' is distinct from '1'::jsonb
      or cont->>'companyId' is distinct from key or cont->'candidate' is distinct from 'null'::jsonb
      or cont->>'collection' is distinct from 'idvs' or cont->'page' is distinct from '1'::jsonb
      or cont->'targetIndex' is distinct from '0'::jsonb or cont->'searchAfter' is distinct from 'null'::jsonb
      or cont->'lastPageHash' is distinct from 'null'::jsonb
      or coalesce(cont->>'companyIdentity','') !~ '^[0-9a-f]{64}$'
      or row->'searchEndDate' is distinct from cont->'searchEndDate'
      or coalesce(cont->>'searchEndDate','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(cont->'targets') is distinct from 'array' or jsonb_array_length(cont->'targets')<>1
      or cont ?| array['candidateQueue','pendingPage','evaluatedRecipients','foundVerified'] then
      raise exception 'federal capacity journal outcome is not the bounded no-write search';
    end if;
    -- A real calendar date and one exact, unbound original query are required.
    perform (cont->>'searchEndDate')::date;
    target := cont->'targets'->0;
    if jsonb_typeof(target) is distinct from 'object' or target->'identity' is distinct from 'null'::jsonb
      or jsonb_typeof(target->'query') is distinct from 'string' or length(btrim(target->>'query')) not between 1 and 500 then
      raise exception 'federal capacity journal query identity invalid';
    end if;
    next_map := next_map || jsonb_build_object(key,cont);
  end loop;
  select count(*) into next_count from jsonb_object_keys(next_map);
  if next_count<=1000 or next_count>1004 or next_count<>prior_count+jsonb_array_length(ids) then
    raise exception 'federal capacity recovery requires exact bounded overflow';
  end if;
  hold := jsonb_build_object('version',1,'status','held','reason','reviewed_journal_capacity_recovery_requires_manual_resume',
    'operationId',operation_id,'journalId',journal_id,'companyIds',ids,'evidenceSha256',p_request->>'evidenceSha256',
    'readerTaskId',p_request->>'readerTaskId','reviewerTaskId',p_request->>'reviewerTaskId','heldAt',stamp);
  next_cursor := s.cursor || jsonb_build_object('discoveryContinuations',next_map,'discoveryInFlight','[]'::jsonb,
    'discoveryInFlightEventId',null,'discoveryCapacityHold',hold);
  receipt := jsonb_build_object('eventId',operation_id,'source','federal-discovery','status','held','request',p_request,
    'hold',hold,'journalId',journal_id,'companyIds',ids,'sourceRequests',0,'journaledSourceRequests',jsonb_array_length(ids),
    'providerReplay',false,'attemptsCredited',0,
    'historyComplete',false,'coverageVerified',false,'priorContinuationCount',prior_count,'pendingSearches',next_count,
    'afterCompanyId',s.cursor->'afterCompanyId','attemptsTotal',s.cursor->'discoveryAttemptsTotal',
    'beforeCursorMd5',md5(s.cursor::text),'afterCursorMd5',md5(next_cursor::text),
    'retainedJournalMd5',md5(j.meta::text),'preservedOtherCursorMd5',md5((s.cursor-'discoveryContinuations'-'discoveryInFlight'-'discoveryInFlightEventId')::text));
  update public.public_growth_sweep_state set cursor=next_cursor,updated_at=now() where source='federal-discovery';
  insert into public.app_events(id,module,kind,entity_type,entity_id,summary,meta)
    values(operation_id,'headhunter','federal.discovery.capacity_hold','cron','federal-discovery',
      'Unfinished journal preserved under explicit capacity hold; no provider replay or completion',receipt);
  return receipt;
end;
$$;
revoke all on function public.reconcile_federal_discovery_capacity_hold(jsonb) from public, anon, authenticated;
grant execute on function public.reconcile_federal_discovery_capacity_hold(jsonb) to service_role;
