-- Exact NetSuite IDs may share a website. Their unique domain can be null while
-- website_raw retains the source URL. Keep those current leads in ATS/site
-- rotation without merging identity. Historical migration0042 is unchanged.

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
        where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
          and c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (c.ats_checked_at is null or c.ats_checked_at < p_epoch)
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
        where c.status is distinct from 'removed_from_tam'
          and (nullif(btrim(c.domain), '') is not null or nullif(btrim(c.website_raw), '') is not null)
          and (c.site_checked_at is null or c.site_checked_at < p_epoch)
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
