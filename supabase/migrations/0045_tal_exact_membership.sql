-- 0045: replace TAL membership atomically by exact NetSuite Internal ID.
--
-- The API resolves the uploaded IDs to canonical company UUIDs first. This RPC
-- revalidates that identity inside the transaction, rejects ambiguous active
-- duplicates, applies the complete replacement, and verifies the resulting set.
-- Names and domains never participate in membership identity.

create or replace function sync_tal_exact_membership(
  p_company_ids uuid[],
  p_internal_ids text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_input_count int;
  v_newly_claimed int;
  v_newly_dq int;
  v_verified_count int;
begin
  v_input_count := cardinality(p_company_ids);
  if v_input_count is null
     or v_input_count = 0
     or cardinality(p_internal_ids) is distinct from v_input_count then
    raise exception 'TAL replacement requires equal non-empty company and Internal ID arrays';
  end if;

  if exists (
    select 1
    from unnest(p_internal_ids) as value
    where value is null or value !~ '^[0-9]+$'
  ) then
    raise exception 'TAL replacement contains a non-numeric NetSuite Internal ID';
  end if;

  if (select count(distinct value) from unnest(p_company_ids) as value) <> v_input_count
     or (select count(distinct value) from unnest(p_internal_ids) as value) <> v_input_count then
    raise exception 'TAL replacement contains duplicate company or Internal IDs';
  end if;

  -- Whole-list replacement is one global resource. Without a transaction-level
  -- lock, two concurrent callers can each validate an old snapshot and commit a
  -- union or overwrite a just-verified replacement after it returns.
  perform pg_advisory_xact_lock(hashtext('stanley:sync_tal_exact_membership'));

  if exists (
    select 1
    from unnest(p_company_ids, p_internal_ids) as requested(company_id, internal_id)
    left join companies c on c.id = requested.company_id
    where c.id is null
       or c.netsuite_internal_id is distinct from requested.internal_id
       or coalesce(c.lists, '{}'::text[]) @> array['tam_duplicate']::text[]
  ) then
    raise exception 'TAL replacement company-to-Internal-ID mapping is stale or retired';
  end if;

  -- A retired row explicitly marked tam_duplicate may share the historical ID.
  -- Any other second row is an unresolved identity ambiguity and fails closed.
  if exists (
    select requested.internal_id
    from unnest(p_internal_ids) as requested(internal_id)
    join companies c on c.netsuite_internal_id = requested.internal_id
    where not (coalesce(c.lists, '{}'::text[]) @> array['tam_duplicate']::text[])
    group by requested.internal_id
    having count(*) <> 1
  ) then
    raise exception 'TAL replacement contains an ambiguous active NetSuite Internal ID';
  end if;

  select count(*) into v_newly_claimed
  from companies
  where id = any(p_company_ids)
    and not tal_claimed;

  select count(*) into v_newly_dq
  from companies
  where tal_claimed
    and not (id = any(p_company_ids));

  update companies
  set tal_claimed = true,
      tal_dq = false
  where id = any(p_company_ids);

  update companies
  set tal_claimed = false,
      tal_dq = true
  where tal_claimed
    and not (id = any(p_company_ids));

  select count(*) into v_verified_count
  from companies
  where tal_claimed;

  if v_verified_count <> v_input_count
     or exists (
       select 1
       from unnest(p_company_ids) as requested(company_id)
       left join companies c on c.id = requested.company_id and c.tal_claimed
       where c.id is null
     ) then
    raise exception 'TAL replacement exact-set verification failed';
  end if;

  return jsonb_build_object(
    'claimed', v_verified_count,
    'newly_claimed', v_newly_claimed,
    'newly_dq', v_newly_dq
  );
end;
$$;

revoke all on function sync_tal_exact_membership(uuid[], text[])
  from public, anon, authenticated;
grant execute on function sync_tal_exact_membership(uuid[], text[])
  to service_role;

-- Make every RPC added by the 0042-0045 remediation visible immediately even
-- on projects without a DDL event trigger that refreshes PostgREST's cache.
notify pgrst, 'reload schema';
