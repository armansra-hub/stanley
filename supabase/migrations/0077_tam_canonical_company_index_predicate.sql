create or replace function tam_canonical_company_id(p_netsuite_internal_id text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
begin
  if p_netsuite_internal_id is null or p_netsuite_internal_id !~ '^[0-9]+$' then
    raise exception 'exact numeric NetSuite Internal ID is required';
  end if;

  select array_agg(c.id order by c.id)
    into v_ids
  from companies c
  where c.netsuite_internal_id = p_netsuite_internal_id
    and c.netsuite_internal_id ~ '^[0-9]+$'
    and not ('tam_duplicate' = any(coalesce(c.lists, '{}'::text[])));

  if coalesce(cardinality(v_ids), 0) = 0 then
    return null;
  end if;
  if cardinality(v_ids) <> 1 then
    raise exception 'exact NetSuite Internal ID % has % non-retired company rows; expected 1',
      p_netsuite_internal_id, cardinality(v_ids);
  end if;
  return v_ids[1];
end;
$$;

notify pgrst, 'reload schema';
