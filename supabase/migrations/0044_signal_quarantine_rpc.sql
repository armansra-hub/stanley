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
set search_path = public
as $$
declare
  marker jsonb;
begin
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'p_reason is required';
  end if;
  if p_batch is null or btrim(p_batch) = '' then
    raise exception 'p_batch is required';
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
    and (
      not (coalesce(metadata, '{}'::jsonb) ? 'stanley_quarantine')
      or jsonb_typeof(metadata -> 'stanley_quarantine') is distinct from 'object'
      or metadata #> '{stanley_quarantine,active}' is distinct from 'true'::jsonb
    )
  returning metadata -> 'stanley_quarantine' into marker;

  return marker; -- null means missing/already marked; safe to retry
end;
$$;

revoke all on function quarantine_trigger(uuid, text, text, text) from public;
revoke all on function quarantine_trigger(uuid, text, text, text) from anon;
revoke all on function quarantine_trigger(uuid, text, text, text) from authenticated;
grant execute on function quarantine_trigger(uuid, text, text, text) to service_role;
