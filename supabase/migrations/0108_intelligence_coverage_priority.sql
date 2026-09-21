-- Fair first-pass progress within existing source reservations and Jev work.
-- Cadences, eligibility, failure backoff, provider questions and worker lease
-- fencing are unchanged. Missing interpretation prioritizes already captured
-- work; it never causes an additional source download or a second queue.
begin;
alter table public.intelligence_config
  add column coverage_rotation_turns jsonb not null default '{}'::jsonb,
  add column coverage_claim_turns jsonb not null default '{}'::jsonb;

create index intelligence_current_account_evidence
  on public.intelligence_observations(company_id) where is_current and not feedback_excluded;
create index intelligence_current_account_interpreted
  on public.intelligence_observations(company_id) where is_current and not feedback_excluded and attributes is not null;

create or replace function reserve_company_rotation(
  p_source text,
  p_limit integer,
  p_epoch timestamptz,
  p_scope text default null
)
returns setof companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  adaptive_enabled boolean := coalesce((select enabled from public.intelligence_config where id=1),false);
  first_pass_slots integer := 0;
  ordinary_slots integer;
  rotation_turn bigint;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'rotation reservation limit must be between 1 and 1000';
  end if;
  if p_epoch is null or p_epoch > clock_timestamp() then
    raise exception 'rotation reservation requires a non-future UTC daily epoch';
  end if;

  -- Half of each immediately attempted batch remains oldest-due monitoring.
  -- Single-item recovery calls alternate instead of permanently starving either
  -- lane. These counters belong to the existing configuration, not a new queue.
  if adaptive_enabled and p_source in ('trigger','site','ats')
    and (p_source <> 'site' or p_scope='claimable') then
    if p_limit=1 then
      update public.intelligence_config set coverage_rotation_turns=jsonb_set(
        coverage_rotation_turns,array[p_source],
        to_jsonb(coalesce((coverage_rotation_turns->>p_source)::bigint,0)+1),true)
        where id=1 returning (coverage_rotation_turns->>p_source)::bigint into rotation_turn;
      first_pass_slots := case when rotation_turn % 2=0 then 1 else 0 end;
    else first_pass_slots := p_limit / 2;
    end if;
  end if;
  ordinary_slots := p_limit-first_pass_slots;

  if p_source = 'trigger' then
    return query
      with ordinary as materialized (
        select c.id, c.last_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.last_checked_at is null or c.last_checked_at < p_epoch)
        order by c.last_checked_at asc nulls first, c.id
        for update of c skip locked
        limit ordinary_slots
      ), first_pass as materialized (
        select c.id, c.last_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.last_checked_at is null or c.last_checked_at < p_epoch)
          and c.id not in (select id from ordinary)
          and not exists (select 1 from public.intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded)
        order by c.last_checked_at asc nulls first, c.id
        for update of c skip locked
        limit first_pass_slots
      ), remainder as materialized (
        select c.id, c.last_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.last_checked_at is null or c.last_checked_at < p_epoch)
          and c.id not in (select id from ordinary union all select id from first_pass)
        order by c.last_checked_at asc nulls first, c.id
        for update of c skip locked
        limit greatest(0,p_limit-(select count(*)::integer from ordinary)-(select count(*)::integer from first_pass))
      ), selected as (
        select * from ordinary union all select * from first_pass union all select * from remainder
      ), reserved as (
        update companies c
        set last_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  if p_source = 'ats' then
    return query
      with ordinary as materialized (
        select c.id, c.ats_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key=case when c.ats_type is not null and c.ats_type<>'none' and c.ats_token is not null then 'ats:' || c.ats_type || ':' || c.ats_token else 'ats:discovery' end
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.ats_checked_at is null or c.ats_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.ats_checked_at is null or c.ats_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
        order by c.ats_checked_at asc nulls first, c.id
        for update of c skip locked
        limit ordinary_slots
      ), first_pass as materialized (
        select c.id, c.ats_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key=case when c.ats_type is not null and c.ats_type<>'none' and c.ats_token is not null then 'ats:' || c.ats_type || ':' || c.ats_token else 'ats:discovery' end
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.ats_checked_at is null or c.ats_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.ats_checked_at is null or c.ats_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
          and c.id not in (select id from ordinary)
          and not exists (select 1 from public.intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded)
        order by c.ats_checked_at asc nulls first, c.id
        for update of c skip locked
        limit first_pass_slots
      ), remainder as materialized (
        select c.id, c.ats_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key=case when c.ats_type is not null and c.ats_type<>'none' and c.ats_token is not null then 'ats:' || c.ats_type || ':' || c.ats_token else 'ats:discovery' end
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.ats_checked_at is null or c.ats_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.ats_checked_at is null or c.ats_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
          and c.id not in (select id from ordinary union all select id from first_pass)
        order by c.ats_checked_at asc nulls first, c.id
        for update of c skip locked
        limit greatest(0,p_limit-(select count(*)::integer from ordinary)-(select count(*)::integer from first_pass))
      ), selected as (
        select * from ordinary union all select * from first_pass union all select * from remainder
      ), reserved as (
        update companies c
        set ats_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  if p_source = 'signals' then
    return query
      with selected as (
        select c.id, c.signals_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.signals_checked_at is null or c.signals_checked_at < p_epoch)
        order by c.signals_checked_at asc nulls first, c.id
        for update of c skip locked
        limit p_limit
      ), reserved as (
        update companies c
        set signals_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  if p_source = 'site' then
    if p_scope is null or p_scope not in ('claimable', 'tail') then
      raise exception 'site rotation scope must be claimable or tail';
    end if;
    return query
      with ordinary as materialized (
        select c.id, c.site_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key='website'
        where c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.site_checked_at is null or c.site_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.site_checked_at is null or c.site_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
          and (
            (p_scope = 'claimable' and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
              and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$')
            or (p_scope = 'tail' and coalesce(c.is_base, false) and c.claimable is not true)
          )
        order by c.site_checked_at asc nulls first, c.id
        for update of c skip locked
        limit ordinary_slots
      ), first_pass as materialized (
        select c.id, c.site_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key='website'
        where c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.site_checked_at is null or c.site_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.site_checked_at is null or c.site_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
          and (
            (p_scope = 'claimable' and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
              and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$')
            or (p_scope = 'tail' and coalesce(c.is_base, false) and c.claimable is not true)
          )
          and c.id not in (select id from ordinary)
          and not exists (select 1 from public.intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded)
        order by c.site_checked_at asc nulls first, c.id
        for update of c skip locked
        limit first_pass_slots
      ), remainder as materialized (
        select c.id, c.site_checked_at as prior_checked_at
        from companies c
        left join public.intelligence_source_state st
          on st.company_id=c.id and st.source_key='website'
        where c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (not adaptive_enabled or st.next_attempt_at is null or st.next_attempt_at <= clock_timestamp())
          and (c.site_checked_at is null or c.site_checked_at < p_epoch)
          -- Keep the existing reservation owner and avoid a second claim across
          -- an hourly boundary while its bounded worker is still running.
          and (c.site_checked_at is null or c.site_checked_at < clock_timestamp()-interval '10 minutes')
          -- Only a successful complete scan can defer a revisit. Unknown or
          -- malformed history, source errors and partial scans stay hourly.
          and (not adaptive_enabled or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
          and (
            (p_scope = 'claimable' and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
              and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$')
            or (p_scope = 'tail' and coalesce(c.is_base, false) and c.claimable is not true)
          )
          and c.id not in (select id from ordinary union all select id from first_pass)
        order by c.site_checked_at asc nulls first, c.id
        for update of c skip locked
        limit greatest(0,p_limit-(select count(*)::integer from ordinary)-(select count(*)::integer from first_pass))
      ), selected as (
        select * from ordinary union all select * from first_pass union all select * from remainder
      ), reserved as (
        update companies c
        set site_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  if p_source = 'fmcsa' then
    return query
      with selected as (
        select c.id, c.fmcsa_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.fmcsa_checked_at is null or c.fmcsa_checked_at < p_epoch)
          and (
            c.subindustry ilike '%truck%'
            or c.subindustry ilike '%transport%'
            or c.subindustry ilike '%logistic%'
            or c.subindustry ilike '%freight%'
            or c.subindustry ilike '%carrier%'
            or c.subindustry ilike '%warehous%'
            or c.subindustry ilike '%moving%'
            or c.subindustry ilike '%hauling%'
          )
        order by c.fmcsa_checked_at asc nulls first, c.id
        for update of c skip locked
        limit p_limit
      ), reserved as (
        update companies c
        set fmcsa_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  if p_source = 'sos' then
    if p_scope is null or btrim(p_scope) = '' then
      raise exception 'SOS rotation requires a state scope';
    end if;
    return query
      with selected as (
        select c.id, c.sos_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and c.state = p_scope
          and (c.sos_checked_at is null or c.sos_checked_at < p_epoch)
        order by c.sos_checked_at asc nulls first, c.id
        for update of c skip locked
        limit p_limit
      ), reserved as (
        update companies c
        set sos_checked_at = clock_timestamp()
        from selected s
        where c.id = s.id
        returning c.*
      )
      select r.* from reserved r join selected s on s.id = r.id
      order by s.prior_checked_at asc nulls first, r.id;
    return;
  end if;

  raise exception 'unsupported rotation source %', p_source;
end;
$$;

revoke all on function reserve_company_rotation(text, integer, timestamptz, text)
  from public, anon, authenticated;
grant execute on function reserve_company_rotation(text, integer, timestamptz, text)
  to service_role;

-- Normal workers claim three: oldest debt, an uncovered account, then fresh
-- priority evidence. Small final batches rotate their scarce non-oldest slots.
create or replace function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare
  batch_limit integer;
  oldest_slots integer := 1;
  coverage_slots integer;
  claim_turn bigint;
begin
  if p_limit is null or p_limit<1 then raise exception 'intelligence claim limit must be positive'; end if;
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  batch_limit := least(p_limit,12);
  coverage_slots := (batch_limit-1)/2;
  if batch_limit<3 then
    update intelligence_config set coverage_claim_turns=jsonb_set(
      coverage_claim_turns,array[batch_limit::text],
      to_jsonb(coalesce((coverage_claim_turns->>batch_limit::text)::bigint,0)+1),true)
      where id=1 returning (coverage_claim_turns->>batch_limit::text)::bigint into claim_turn;
    if batch_limit=1 then
      oldest_slots := case when (claim_turn-1)%3=0 then 1 else 0 end;
      coverage_slots := case when (claim_turn-1)%3=1 then 1 else 0 end;
    else
      coverage_slots := case when claim_turn%2=1 then 1 else 0 end;
    end if;
  end if;
  update intelligence_jobs set status='failed',last_error='attempts_exhausted',lease_token=null,lease_until=null
    where attempts>=5 and (status='queued' or (status='running' and lease_until<now()));
  return query
    with oldest as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and (status='queued' or (status='running' and lease_until<now()))
      order by due_at,priority desc,created_at,id
      for update skip locked limit oldest_slots
    ), uncovered as materialized (
      select j.id from intelligence_jobs j
      join intelligence_observations o on o.id=j.observation_id
      where j.kind='interpret' and o.is_current and not o.feedback_excluded and j.attempts<5 and j.due_at<=now()
        and (j.status='queued' or (j.status='running' and j.lease_until<now()))
        and j.id not in(select id from oldest)
        and not exists(select 1 from intelligence_observations known
          where known.company_id=o.company_id and known.is_current and not known.feedback_excluded and known.attributes is not null)
        -- A first interpretation already selected in the oldest lane also
        -- advances coverage; prefer another account in the dedicated lane.
        and not exists(select 1 from oldest selected
          join intelligence_jobs sj on sj.id=selected.id
          join intelligence_observations so on so.id=sj.observation_id
          where sj.kind='interpret' and so.company_id=o.company_id)
      order by case when j.result->>'routingBackfill'='business-services-v1' then 1 else 0 end,
        j.priority desc,j.due_at,j.created_at,j.id
      for update of j skip locked limit coverage_slots
    ), fresh as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and id not in(select id from oldest union all select id from uncovered)
        and (status='queued' or (status='running' and lease_until<now()))
      order by case when result->>'routingBackfill'='business-services-v1' then 1 else 0 end,
        priority desc,due_at,created_at,id
      for update skip locked
      limit greatest(0,batch_limit-(select count(*)::integer from oldest)-(select count(*)::integer from uncovered))
    ), ready as (
      select id from oldest union all select id from uncovered union all select id from fresh
    ) update intelligence_jobs j set status='running',attempts=j.attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
      from ready where j.id=ready.id returning j.*;
end $$;
revoke all on function public.intelligence_claim(integer) from public,anon,authenticated;
grant execute on function public.intelligence_claim(integer) to service_role;
notify pgrst,'reload schema';
commit;
