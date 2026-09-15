-- Exact current TAM admission for companies outside the existing verified
-- recipient/award rotations. Keep those recurring selectors unchanged.
create or replace function public.list_federal_discovery_tam_batch(
  p_limit integer,
  p_after_company_id uuid default null
)
returns setof public.companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Twenty attempted companies plus one keyset lookahead.
  if p_limit is null or p_limit < 1 or p_limit > 21 then
    raise exception 'federal discovery limit must be between 1 and 21';
  end if;
  return query
    select c.* from public.companies c
    where (p_after_company_id is null or c.id > p_after_company_id)
      and coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
      and c.status is distinct from 'removed_from_tam'
      and not exists (
        select 1
        from public.company_government_matches m
        join public.government_entities e on e.id = m.government_entity_id
        where m.company_id = c.id
          and m.match_status = 'verified'
          and (
            e.usaspending_recipient_id is not null
            or exists (
              select 1 from public.federal_awards a
              where a.government_entity_id = e.id
            )
          )
      )
    order by c.id
    limit p_limit;
end;
$$;

revoke all on function public.list_federal_discovery_tam_batch(integer, uuid)
  from public, anon, authenticated;
grant execute on function public.list_federal_discovery_tam_batch(integer, uuid)
  to service_role;
notify pgrst, 'reload schema';
