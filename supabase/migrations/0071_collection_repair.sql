-- Collection repair: explicit source outcomes, eligible-TAM baseline priority,
-- bounded failure retries. Does not write grades, membership, or trigger verdicts.
begin;
alter table public.intelligence_source_state
  add column coverage_status text not null default 'unknown'
    check(coverage_status in ('complete','partial','empty','unavailable','unsupported','unknown')),
  add column error_details jsonb not null default '{}'::jsonb,
  add column next_attempt_at timestamptz;
-- Old empty news arrays could mean quiet feeds or errors: unknown until a new poll.
update public.intelligence_source_state set coverage_status=case
  when last_error is null and complete then 'complete'
  when last_error is null then 'partial'
  when source_key='website' and jsonb_array_length(case when jsonb_typeof(cursor->'verifiedUrls')='array' then cursor->'verifiedUrls' else '[]'::jsonb end)>0 then 'partial'
  when source_key='news:google' and coalesce(jsonb_array_length(case when jsonb_typeof(cursor->'pending')='array' then cursor->'pending' else '[]'::jsonb end),0)=0 then 'unknown'
  else 'unavailable' end;
create index intelligence_source_state_next_attempt on public.intelligence_source_state(next_attempt_at) where next_attempt_at is not null;
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
declare adaptive_enabled boolean := coalesce((select enabled from public.intelligence_config where id=1),false);
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'rotation reservation limit must be between 1 and 1000';
  end if;
  if p_epoch is null or p_epoch > clock_timestamp() then
    raise exception 'rotation reservation requires a non-future UTC daily epoch';
  end if;

  if p_source = 'trigger' then
    return query
      with selected as (
        select c.id, c.last_checked_at as prior_checked_at
        from companies c
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (c.last_checked_at is null or c.last_checked_at < p_epoch)
        order by c.last_checked_at asc nulls first, c.id
        for update of c skip locked
        limit p_limit
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
      with selected as (
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
        limit p_limit
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
      with selected as (
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
        order by case when adaptive_enabled and p_scope='claimable' and not exists(
          select 1 from intelligence_observations o where o.company_id=c.id and o.is_current) then 0 else 1 end,
          c.site_checked_at asc nulls first, c.id
        for update of c skip locked
        limit p_limit
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

create or replace function public.intelligence_status()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with eligible as materialized (
    select id from companies where lists @> array['netsuite_tam']::text[]
      and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$'
  ), coverage as materialized (
    select s.* from intelligence_source_state s join eligible c on c.id=s.company_id
  ) select jsonb_build_object(
    'enabled',(select enabled from intelligence_config where id=1),
    'spend',jsonb_build_object(
      'usedUsd',(select coalesce(sum(charged_usd),0) from intelligence_spend where month=date_trunc('month',now() at time zone 'UTC')::date),
      'reservedUsd',(select coalesce(sum(reserved_usd),0) from intelligence_spend where state='reserved' and month=date_trunc('month',now() at time zone 'UTC')::date),
      'limitUsd',(select monthly_limit_usd from intelligence_config where id=1)),
    'jobs',jsonb_build_object(
      'queued',(select count(*) from intelligence_jobs where status='queued'),
      'running',(select count(*) from intelligence_jobs where status='running'),
      'failed',(select count(*) from intelligence_jobs where status='failed')),
    'sourceCoverage',jsonb_build_object(
      'scope','eligible_tam',
      'complete',(select count(*) from coverage where coverage_status='complete'),
      'partial',(select count(*) from coverage where coverage_status='partial'),
      'failed',(select count(*) from coverage where coverage_status='unavailable'),
      'empty',(select count(*) from coverage where coverage_status='empty'),
      'unsupported',(select count(*) from coverage where coverage_status='unsupported'),
      'unknown',(select count(*) from coverage where coverage_status='unknown'),
      'withWarnings',(select count(*) from coverage where coverage_status in ('complete','partial') and last_error is not null),
      'accountsWithSuccess48h',(select count(distinct company_id) from coverage where last_success_at>=now()-interval '48 hours'))
  );
$$;

-- Public publisher RSS endpoints returned RSS/XML content types in research.
-- First cloud polls, article availability and TAM yield remain measured outcomes;
-- subscriber-only article bodies are neither bypassed nor counted as captured.
insert into public.intelligence_shared_sources
 (id,name,url,enabled,format,scope,states,verification_url,verified_at,poll_minutes,coverage_description)
values
 ('digiday','Digiday media and agency reporting','https://digiday.com/feed/',true,'rss','industry','{}',
  'https://digiday.com/','2026-09-19T04:00:00Z',30,
  'Publisher RSS for media, advertising, publishing and agency developments. Publicly available feed and article evidence only; some stories require subscriptions. Limited rolling publisher coverage, not every territory account.'),
 ('adweek','ADWEEK advertising and agency reporting','https://www.adweek.com/feed/',true,'rss','industry','{}',
  'https://www.adweek.com/about/','2026-09-19T04:00:00Z',30,
  'Advertising and media publisher feed, including agency changes, new business, leadership and service launches. Some linked stories are subscriber-only; no paywall bypass or assumption of complete article access.'),
 ('staffinghub','Staffing Hub staffing industry reporting','https://staffinghub.com/feed/',true,'rss','industry','{}',
  'https://staffinghub.com/','2026-09-19T04:00:00Z',30,
  'Staffing and recruiting agency news, acquisitions, operating models, technology and leadership. Publisher-selected reporting and sponsored material are attributed to the source; no assumption that client placements are internal hires.')
on conflict(id) do update set name=excluded.name,url=excluded.url,format=excluded.format,scope=excluded.scope,
 verification_url=excluded.verification_url,verified_at=excluded.verified_at,poll_minutes=excluded.poll_minutes,coverage_description=excluded.coverage_description;

notify pgrst,'reload schema';
commit;
