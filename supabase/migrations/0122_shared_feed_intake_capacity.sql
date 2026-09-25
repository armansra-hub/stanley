-- Cached article bodies may legitimately exceed the 2 MB excerpt-intake
-- allowance. They must not consume that separate allowance and starve every
-- feed. Keep the existing 8 MB total payload ceiling and all leases/dedupe.
-- No cleanup or deletion: completed receipts and pending evidence stay intact.
begin;

create or replace function public.intelligence_shared_snapshot(
  p_source text,p_lease uuid,p_items jsonb,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare
  source public.intelligence_shared_sources;
  incoming integer;
  incoming_bytes bigint;
  source_items bigint;
  total_bytes bigint;
  intake_bytes bigint;
begin
  select * into source from public.intelligence_shared_sources
    where id=p_source and lease_token=p_lease and lease_until>now() for update;
  if not found then raise exception 'shared_source_lease_lost'; end if;
  if p_error is not null then
    update public.intelligence_shared_sources set last_fetch_status='error',last_fetch_error=left(p_error,200),last_fetch_at=now(),
      next_fetch_at=now()+make_interval(mins=>poll_minutes) where id=p_source;
    return;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>250 then raise exception 'invalid_shared_items'; end if;
  perform pg_advisory_xact_lock(hashtext('intelligence_shared_storage'));

  select count(*),coalesce(sum(octet_length((v->'payload')::text)),0)
    into incoming,incoming_bytes from jsonb_array_elements(p_items) v
    where not exists(select 1 from public.intelligence_shared_items i where i.source_id=p_source and i.item_key=v->>'item_key');
  select count(*) filter(where source_id=p_source),
    coalesce(sum(octet_length(payload::text)),0),
    coalesce(sum(octet_length(payload::text)) filter(where not complete and payload->>'bodyFetched' is distinct from 'true'),0)
    into source_items,total_bytes,intake_bytes from public.intelligence_shared_items;

  if source_items+incoming>5000 then raise exception 'shared_source_capacity_exceeded'; end if;
  -- Bound the unfinished feed excerpts separately from cached article bodies
  -- and completed dedupe receipts. The same 8 MB total ceiling used by article
  -- caching also applies to new intake; no source can grow storage without bound.
  if incoming_bytes>0 and (intake_bytes+incoming_bytes>2000000 or total_bytes+incoming_bytes>8000000) then
    raise exception 'shared_source_storage_capacity_exceeded';
  end if;
  insert into public.intelligence_shared_items(source_id,item_key,payload)
    select p_source,v->>'item_key',v->'payload' from jsonb_array_elements(p_items) v
    on conflict(source_id,item_key) do nothing;
  update public.intelligence_shared_sources set last_fetch_at=now(),last_success_at=now(),last_fetch_error=null,
    last_fetch_status=case when jsonb_array_length(p_items)=0 then 'empty' else 'success' end,
    last_item_count=jsonb_array_length(p_items),next_fetch_at=now()+make_interval(mins=>poll_minutes)
    where id=p_source;
end $$;

revoke all on function public.intelligence_shared_snapshot(text,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.intelligence_shared_snapshot(text,uuid,jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;
