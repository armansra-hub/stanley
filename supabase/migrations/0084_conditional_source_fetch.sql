-- Reuse retained RSS snapshots on 304. Never replace pending items with an
-- empty response or advance validators before the source snapshot is durable.
begin;
alter table public.intelligence_shared_sources add column if not exists http_validators jsonb;
alter table public.intelligence_shared_sources add column if not exists last_http_status integer;
alter table public.intelligence_shared_sources add column if not exists last_entity_repairs integer not null default 0;

create or replace function public.intelligence_shared_http_snapshot(
  p_source text,p_lease uuid,p_items jsonb,p_error text default null,
  p_validators jsonb default null,p_not_modified boolean default false,p_entity_repairs integer default 0)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare source public.intelligence_shared_sources;
begin
  select * into source from public.intelligence_shared_sources
    where id=p_source and lease_token=p_lease and lease_until>now() for update;
  if not found then raise exception 'shared_source_lease_lost'; end if;
  if p_not_modified then
    if p_error is not null or source.last_success_at is null or source.http_validators is null
      or source.http_validators->>'url'<>source.url then raise exception 'shared_304_without_snapshot'; end if;
    update public.intelligence_shared_sources set last_fetch_at=now(),last_success_at=now(),last_fetch_error=null,
      last_http_status=304,last_fetch_status=case when last_item_count=0 then 'empty' else 'success' end,
      next_fetch_at=now()+make_interval(mins=>poll_minutes)
      where id=p_source;
    -- Keep last_item_count, pending retries, completed dedupe receipts and the
    -- original snapshot's empty/success status intact.
    return;
  end if;
  perform public.intelligence_shared_snapshot(p_source,p_lease,p_items,p_error);
  if p_error is null then
    if p_validators is not null and (jsonb_typeof(p_validators)<>'object' or octet_length(p_validators::text)>1400) then
      raise exception 'invalid_http_validators';
    end if;
    update public.intelligence_shared_sources set http_validators=p_validators,last_http_status=200,
      last_entity_repairs=greatest(0,least(100000,coalesce(p_entity_repairs,0))) where id=p_source;
  end if;
end $$;
revoke all on function public.intelligence_shared_http_snapshot(text,uuid,jsonb,text,jsonb,boolean,integer) from public,anon,authenticated;
grant execute on function public.intelligence_shared_http_snapshot(text,uuid,jsonb,text,jsonb,boolean,integer) to service_role;
notify pgrst,'reload schema';
commit;
