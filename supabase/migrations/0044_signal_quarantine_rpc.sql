-- 0044: non-destructive trigger quarantine.
--
-- Trigger rows are evidence and must not be deleted. This service-role-only RPC
-- atomically adds an audit marker inside the existing metadata JSONB. The app's
-- visibility and priority gates ignore marked rows while preserving the complete
-- source record for later review or reversal.

create or replace function quarantine_trigger(
  p_trigger_id uuid,
  p_reason text,
  p_batch text,
  p_actor text default 'stanley-signal-integrity'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  marker jsonb;
  existing_marker jsonb;
  changed boolean := false;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'p_reason is required';
  end if;
  if p_batch is null or btrim(p_batch) = '' then
    raise exception 'p_batch is required';
  end if;

  select metadata -> 'stanley_quarantine'
  into existing_marker
  from triggers
  where id = p_trigger_id
  for update;

  if not found then
    return null;
  end if;

  if jsonb_typeof(existing_marker) = 'object'
     and existing_marker #> '{active}' = 'true'::jsonb then
    return jsonb_build_object('marker', existing_marker, 'changed', false);
  end if;

  update triggers
  set metadata = jsonb_set(
    coalesce(metadata, '{}'::jsonb),
    '{stanley_quarantine}',
    jsonb_build_object(
      'active', true,
      'reason', p_reason,
      'batch', p_batch,
      'actor', coalesce(nullif(btrim(p_actor), ''), 'stanley-signal-integrity'),
      'quarantined_at', now()
    ),
    true
  )
  where id = p_trigger_id
  returning metadata -> 'stanley_quarantine' into marker;
  changed := marker is not null;

  return case
    when marker is null then null
    else jsonb_build_object('marker', marker, 'changed', changed)
  end;
end;
$$;

-- Serialize the trigger-alert repair with every writer that subsequently updates
-- the company row. The SQL predicate is deliberately conservative: any trigger
-- that is not explicitly quarantined prevents a clear. has_new_signal belongs to
-- the separate signals table and must never be changed by trigger cleanup.
create or replace function reconcile_company_signal_flags(
  p_company_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_company companies%rowtype;
  v_unquarantined bigint;
begin
  select c.*
  into v_company
  from companies c
  where c.id = p_company_id
  for update;

  if not found then
    return null;
  end if;

  select count(*)
  into v_unquarantined
  from triggers t
  where t.company_id = p_company_id
    and not coalesce(
      t.metadata #> '{stanley_quarantine,active}' = 'true'::jsonb,
      false
    );

  if v_unquarantined > 0 then
    return jsonb_build_object(
      'cleared', false,
      'tal_alert', v_company.tal_alert,
      'unquarantined_triggers', v_unquarantined
    );
  end if;

  update companies c
  set tal_alert = false
  where c.id = p_company_id
  returning c.* into strict v_company;

  return jsonb_build_object(
    'cleared', true,
    'tal_alert', v_company.tal_alert,
    'unquarantined_triggers', 0
  );
end;
$$;

revoke all on function quarantine_trigger(uuid, text, text, text) from public;
revoke all on function quarantine_trigger(uuid, text, text, text) from anon;
revoke all on function quarantine_trigger(uuid, text, text, text) from authenticated;
revoke all on function reconcile_company_signal_flags(uuid) from public;
revoke all on function reconcile_company_signal_flags(uuid) from anon;
revoke all on function reconcile_company_signal_flags(uuid) from authenticated;
grant execute on function quarantine_trigger(uuid, text, text, text) to service_role;
grant execute on function reconcile_company_signal_flags(uuid) to service_role;

notify pgrst, 'reload schema';
