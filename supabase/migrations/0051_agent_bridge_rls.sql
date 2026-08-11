-- 0051: make the private agent bridge private at the database boundary.
--
-- Migration 0035 predates this hardening and created its four bridge tables in
-- the exposed public schema. Supabase SQL-created tables do not inherit the
-- Dashboard's RLS defaults. Keep 0035 immutable and close access forward-only:
-- browser roles receive no table or sequence privilege and no permissive policy;
-- trusted server routes continue to use the service role.

alter table agent_messages enable row level security;
alter table agent_tasks enable row level security;
alter table lead_documents enable row level security;
alter table score_snapshots enable row level security;
alter table upload_tickets enable row level security;

revoke all on table agent_messages from public, anon, authenticated;
revoke all on table agent_tasks from public, anon, authenticated;
revoke all on table lead_documents from public, anon, authenticated;
revoke all on table score_snapshots from public, anon, authenticated;
revoke all on table upload_tickets from public, anon, authenticated;
revoke all on sequence score_snapshots_id_seq from public, anon, authenticated;

grant all on table agent_messages to service_role;
grant all on table agent_tasks to service_role;
grant all on table lead_documents to service_role;
grant all on table score_snapshots to service_role;
grant all on table upload_tickets to service_role;
grant usage, select on sequence score_snapshots_id_seq to service_role;

-- Coordination RPCs are SECURITY DEFINER and therefore mutate as their owner,
-- not as the calling service_role. Keep direct table access read-only so a leaked
-- server credential cannot bypass lease, provenance, transition, or event gates.
alter table tam_regrade_runs enable row level security;
alter table tam_regrade_actors enable row level security;
alter table tam_regrade_records enable row level security;
alter table tam_regrade_events enable row level security;

revoke all on table tam_regrade_runs from public, anon, authenticated, service_role;
revoke all on table tam_regrade_actors from public, anon, authenticated, service_role;
revoke all on table tam_regrade_records from public, anon, authenticated, service_role;
revoke all on table tam_regrade_events from public, anon, authenticated, service_role;

grant select on table tam_regrade_runs to service_role;
grant select on table tam_regrade_actors to service_role;
grant select on table tam_regrade_records to service_role;
grant select, insert on table tam_regrade_events to service_role;

-- Reserve one use before accepting any ticket-authenticated body. The guarded
-- UPDATE is both validation and consumption, so concurrent requests cannot all
-- spend the same final use. A later body/storage rejection intentionally leaves
-- the use consumed; exceeding the authorization cap is never preferable.
create or replace function reserve_upload_ticket(
  p_ticket_id uuid,
  p_secret_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_ticket upload_tickets%rowtype;
begin
  if p_ticket_id is null
     or p_secret_sha256 is null
     or p_secret_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'valid upload ticket id and SHA-256 are required';
  end if;

  update upload_tickets t
  set uses = t.uses + 1,
      last_used_at = v_now
  where t.id = p_ticket_id
    and t.secret_sha256 = p_secret_sha256
    and t.revoked_at is null
    and t.expires_at > v_now
    and t.uses < t.max_uses
  returning t.* into v_ticket;

  if not found then
    return jsonb_build_object('accepted', false);
  end if;

  return jsonb_build_object(
    'accepted', true,
    'id', v_ticket.id,
    'scope_ids', to_jsonb(v_ticket.scope_ids),
    'remaining', v_ticket.max_uses - v_ticket.uses
  );
end;
$$;

revoke all on function reserve_upload_ticket(uuid, text) from public, anon, authenticated;
grant execute on function reserve_upload_ticket(uuid, text) to service_role;

notify pgrst, 'reload schema';
