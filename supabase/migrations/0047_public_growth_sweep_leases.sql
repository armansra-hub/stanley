-- 0047: fence managed public-growth sweeps and define their recurring sets.
--
-- A managed sweep must hold exactly one source lease. Completion and failure use
-- the opaque token as a fencing value, so an expired worker cannot rewind a cursor
-- after a newer invocation has acquired the source.

alter table public_growth_sweep_state
  add column if not exists lease_token uuid,
  add column if not exists lease_until timestamptz;

create or replace function acquire_public_growth_sweep_lease(
  p_source text,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_token uuid := gen_random_uuid();
  v_state public_growth_sweep_state%rowtype;
begin
  if p_source is null or btrim(p_source) = '' or length(p_source) > 120 then
    raise exception 'public-growth source is required and must be at most 120 characters';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 60 or p_lease_seconds > 900 then
    raise exception 'public-growth lease must be between 60 and 900 seconds';
  end if;

  insert into public_growth_sweep_state (source, cursor, updated_at)
  values (p_source, jsonb_build_object('offset', 0), v_now)
  on conflict (source) do nothing;

  select s.*
  into strict v_state
  from public_growth_sweep_state s
  where s.source = p_source
  for update;

  if v_state.lease_token is not null
    and (v_state.lease_until is null or v_state.lease_until > v_now)
  then
    return jsonb_build_object(
      'acquired', false,
      'lease_until', v_state.lease_until
    );
  end if;

  update public_growth_sweep_state s
  set lease_token = v_token,
      lease_until = v_now + make_interval(secs => p_lease_seconds),
      last_started_at = v_now,
      last_error = null,
      updated_at = v_now
  where s.source = p_source
  returning s.* into strict v_state;

  return jsonb_build_object(
    'acquired', true,
    'lease_token', v_token,
    'lease_until', v_state.lease_until,
    'cursor', coalesce(v_state.cursor, '{}'::jsonb)
  );
end;
$$;

create or replace function complete_public_growth_sweep_lease(
  p_source text,
  p_lease_token uuid,
  p_cursor jsonb,
  p_receipt jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_updated integer;
begin
  if p_source is null or btrim(p_source) = '' or p_lease_token is null then
    raise exception 'public-growth source and lease token are required';
  end if;
  if p_cursor is null or jsonb_typeof(p_cursor) <> 'object' then
    raise exception 'public-growth cursor must be a JSON object';
  end if;
  if p_receipt is null or jsonb_typeof(p_receipt) <> 'object' then
    raise exception 'public-growth receipt must be a JSON object';
  end if;

  update public_growth_sweep_state s
  set cursor = p_cursor,
      last_succeeded_at = v_now,
      last_error = null,
      last_receipt = p_receipt,
      lease_token = null,
      lease_until = null,
      updated_at = v_now
  where s.source = p_source
    and s.lease_token = p_lease_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

create or replace function fail_public_growth_sweep_lease(
  p_source text,
  p_lease_token uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_updated integer;
begin
  if p_source is null or btrim(p_source) = '' or p_lease_token is null then
    raise exception 'public-growth source and lease token are required';
  end if;

  update public_growth_sweep_state s
  set last_error = left(coalesce(p_error, 'unknown public-growth sweep failure'), 1000),
      lease_token = null,
      lease_until = null,
      updated_at = v_now
  where s.source = p_source
    and s.lease_token = p_lease_token;
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end;
$$;

-- Recurring requests revisit only identities already verified by the foundation
-- ingest. They do not discover newly linked companies. Full-TAM discovery and
-- foundation refresh remain a separate explicit-offset operation with a deliberate
-- cadence. This keeps the measured ten-company request budget useful for the known
-- set: USAspending-linked companies cycle monthly, while UEI-linked SAM
-- registrations cycle annually.
create or replace function list_public_growth_recurring_tam_batch(
  p_source text,
  p_limit integer,
  p_offset integer
)
returns setof companies
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_source not in ('usaspending', 'usaspending-subawards', 'sam-entity') then
    raise exception 'unsupported recurring public-growth source %', p_source;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'recurring public-growth limit must be between 1 and 10';
  end if;
  if p_offset is null or p_offset < 0 then
    raise exception 'recurring public-growth offset must be non-negative';
  end if;

  return query
    select c.*
    from companies c
    where coalesce(c.lists, '{}'::text[]) @> array['netsuite_tam']::text[]
      and c.status is distinct from 'removed_from_tam'
      and exists (
        select 1
        from company_government_matches m
        join government_entities e on e.id = m.government_entity_id
        where m.company_id = c.id
          and m.match_status = 'verified'
          and (
            (p_source in ('usaspending', 'usaspending-subawards')
              and (
                e.usaspending_recipient_id is not null
                or exists (
                  select 1 from federal_awards a
                  where a.government_entity_id = e.id
                )
              ))
            or (p_source = 'sam-entity' and e.uei is not null)
          )
      )
    order by c.id
    offset p_offset
    limit p_limit;
end;
$$;

revoke all on function acquire_public_growth_sweep_lease(text, integer)
  from public, anon, authenticated;
revoke all on function complete_public_growth_sweep_lease(text, uuid, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function fail_public_growth_sweep_lease(text, uuid, text)
  from public, anon, authenticated;
revoke all on function list_public_growth_recurring_tam_batch(text, integer, integer)
  from public, anon, authenticated;

grant execute on function acquire_public_growth_sweep_lease(text, integer)
  to service_role;
grant execute on function complete_public_growth_sweep_lease(text, uuid, jsonb, jsonb)
  to service_role;
grant execute on function fail_public_growth_sweep_lease(text, uuid, text)
  to service_role;
grant execute on function list_public_growth_recurring_tam_batch(text, integer, integer)
  to service_role;

notify pgrst, 'reload schema';
