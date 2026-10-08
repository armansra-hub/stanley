-- Opt-in finite source collection through the existing row reservations.
-- The four-argument scheduled function and its fairness counters stay unchanged.
-- A reservation is an attempt fence, never evidence or analysis completion.
begin;
create or replace function public.reserve_company_rotation(
  p_source text,
  p_limit integer,
  p_epoch timestamptz,
  p_scope text,
  p_company_ids uuid[]
)
returns setof public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  checked_column text;
  due_before timestamptz;
  adaptive_enabled boolean := coalesce((select enabled from public.intelligence_config where id=1),false);
begin
  if p_company_ids is null or cardinality(p_company_ids) not between 1 and 100
    or array_ndims(p_company_ids) is distinct from 1
    or array_position(p_company_ids,null) is not null
    or (select count(distinct id) from unnest(p_company_ids) id) <> cardinality(p_company_ids) then
    raise exception 'exact rotation requires 1 to 100 distinct non-null company IDs';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > cardinality(p_company_ids) then
    raise exception 'exact rotation limit must be within the requested company IDs';
  end if;
  if p_epoch is null or not isfinite(p_epoch) or p_epoch > clock_timestamp() then
    raise exception 'exact rotation requires a finite non-future run cutoff';
  end if;
  checked_column := case p_source
    when 'trigger' then 'last_checked_at'
    when 'ats' then 'ats_checked_at'
    when 'site' then 'site_checked_at'
    when 'fmcsa' then 'fmcsa_checked_at'
    when 'sos' then 'sos_checked_at'
  end;
  if checked_column is null then raise exception 'unsupported exact rotation source %',p_source; end if;
  if p_source='site' and p_scope is distinct from 'claimable' then
    raise exception 'exact site rotation requires claimable scope';
  end if;
  if p_source='sos' and (p_scope is null or btrim(p_scope)='') then
    raise exception 'exact SOS rotation requires a state scope';
  end if;
  if p_source not in ('site','sos') and p_scope is not null then
    raise exception 'exact rotation scope is not supported for source %',p_source;
  end if;
  -- Preserve the hourly due fence as well as this run's immutable cutoff.
  -- Once reserved, a company cannot re-enter the same finite run after an hour.
  due_before := least(p_epoch,date_trunc('hour',clock_timestamp() at time zone 'UTC') at time zone 'UTC');
  -- Only this closed source-to-column mapping is interpolated. Every caller
  -- value is bound. Explicit IDs never fall back to other companies.
  return query execute format($query$
    with selected as materialized (
      select c.id,c.%1$I as prior_checked_at
      from public.companies c
      left join public.intelligence_source_state st on st.company_id=c.id
        and st.source_key=case
          when $4='site' then 'website'
          when $4='ats' then case
            when c.ats_type is not null and c.ats_type<>'none' and c.ats_token is not null
              then 'ats:' || c.ats_type || ':' || c.ats_token
            else 'ats:discovery' end
          else null end
      where c.id=any($1)
        and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
        and (c.tal_claimed is true or
          (coalesce(c.lists,'{}'::text[]) @> array['netsuite_tam']::text[]
            and c.status is distinct from 'removed_from_tam'))
        and (c.%1$I is null or c.%1$I < $2)
        and ($4 not in ('ats','site') or (
          (nullif(btrim(c.domain),'') is not null or nullif(btrim(c.website_raw),'') is not null)
          and (c.%1$I is null or c.%1$I < clock_timestamp()-interval '10 minutes')
          and (not $6 or st.next_attempt_at is null or st.next_attempt_at<=clock_timestamp())
          and (not $6 or st.complete is distinct from true or st.last_error is not null
            or st.last_success_at is null or st.cursor #>> '{revisit,version}' is distinct from '1'
            or st.last_success_at + case st.cursor #>> '{revisit,intervalHours}'
              when '2' then interval '2 hours' when '4' then interval '4 hours'
              when '8' then interval '8 hours' when '24' then interval '24 hours'
              else interval '1 hour' end <= clock_timestamp())
        ))
        and ($4<>'site' or c.tal_claimed is true or c.netsuite_internal_id ~ '^[0-9]+$')
        and ($4<>'sos' or c.state=$5)
        and ($4<>'fmcsa' or (
          c.subindustry ilike '%%truck%%' or c.subindustry ilike '%%transport%%'
          or c.subindustry ilike '%%logistic%%' or c.subindustry ilike '%%freight%%'
          or c.subindustry ilike '%%carrier%%' or c.subindustry ilike '%%warehous%%'
          or c.subindustry ilike '%%moving%%' or c.subindustry ilike '%%hauling%%'
        ))
      order by c.%1$I asc nulls first,c.id
      for update of c skip locked
      limit $3
    ), reserved as (
      update public.companies c set %1$I=clock_timestamp()
      from selected s where c.id=s.id returning c.*
    )
    select r.* from reserved r join selected s on s.id=r.id
    order by s.prior_checked_at asc nulls first,r.id
  $query$,checked_column)
  using p_company_ids,due_before,p_limit,p_source,p_scope,adaptive_enabled;
end;
$$;
revoke all on function public.reserve_company_rotation(text,integer,timestamptz,text,uuid[])
  from public,anon,authenticated;
grant execute on function public.reserve_company_rotation(text,integer,timestamptz,text,uuid[])
  to service_role;
notify pgrst,'reload schema';
commit;
