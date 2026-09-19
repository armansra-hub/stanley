-- Adaptive ATS/website revisit timing stored in the existing source cursor.
-- Same source owners, atomic company reservation and oldest-first due ordering.
-- Other source branches and explicit positive-offset recovery stay unchanged.
begin;

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
          on st.company_id=c.id and st.source_key='ats:' || c.ats_type || ':' || c.ats_token
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
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
            (p_scope = 'claimable' and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[])
            or (p_scope = 'tail' and coalesce(c.is_base, false) and c.claimable is not true)
          )
        order by c.site_checked_at asc nulls first, c.id
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

notify pgrst, 'reload schema';

commit;
