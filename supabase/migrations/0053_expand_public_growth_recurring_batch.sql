-- Permit the verified subaward rotation to cover its measured ~250-company
-- baseline in two daily batches. The extra row is the keyset lookahead used to
-- detect the end of an exact-size page without an empty follow-up run.

create or replace function public.list_public_growth_recurring_tam_batch_v2(
  p_source text,
  p_limit integer,
  p_after_company_id uuid default null
)
returns setof public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_source not in ('usaspending', 'usaspending-subawards', 'sam-entity') then
    raise exception 'unsupported recurring public-growth source %', p_source;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 126 then
    raise exception 'recurring public-growth limit must be between 1 and 126';
  end if;

  return query
    select c.*
    from public.companies c
    where (p_after_company_id is null or c.id > p_after_company_id)
      and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
      and c.status is distinct from 'removed_from_tam'
      and exists (
        select 1
        from public.company_government_matches m
        join public.government_entities e on e.id = m.government_entity_id
        where m.company_id = c.id
          and m.match_status = 'verified'
          and (
            (p_source in ('usaspending', 'usaspending-subawards')
              and (
                e.usaspending_recipient_id is not null
                or exists (
                  select 1 from public.federal_awards a
                  where a.government_entity_id = e.id
                )
              ))
            or (p_source = 'sam-entity' and e.uei is not null)
          )
      )
    order by c.id
    limit p_limit;
end;
$$;

revoke all on function public.list_public_growth_recurring_tam_batch_v2(text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.list_public_growth_recurring_tam_batch_v2(text, integer, uuid)
  to service_role;

notify pgrst, 'reload schema';
