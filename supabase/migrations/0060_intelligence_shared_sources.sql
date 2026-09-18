-- Free shared RSS/Atom sources. No federal recovery, entity bindings, TAM, or trigger writes.
-- Global config and deployment env both remain disabled by default (0059).
begin;

create table public.intelligence_shared_sources (
  id text primary key check (id ~ '^[a-z0-9_-]{1,80}$'),
  name text not null,
  url text not null unique check (url ~ '^https?://'),
  enabled boolean not null default false,
  format text not null default 'rss' check (format in ('rss','atom','unsupported')),
  scope text not null check (scope in ('agency','state_local','industry','company')),
  states text[] not null default '{}', cities text[] not null default '{}',
  free_access boolean not null default true,
  verification_url text not null,
  verified_at timestamptz,
  poll_minutes integer not null default 60 check (poll_minutes between 15 and 10080),
  next_fetch_at timestamptz not null default now(),
  last_fetch_at timestamptz, last_success_at timestamptz,
  last_fetch_status text check (last_fetch_status in ('success','empty','error')),
  last_fetch_error text, last_work_error text,
  last_item_count integer, last_attempt_at timestamptz,
  lease_token uuid, lease_until timestamptz
);
create table public.intelligence_shared_items (
  source_id text not null references public.intelligence_shared_sources(id),
  item_key text not null check (item_key ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload)='object' and length(payload::text) <= 60000),
  complete boolean not null default false,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(source_id,item_key)
);
create index intelligence_shared_pending on public.intelligence_shared_items(source_id,next_attempt_at,created_at) where not complete;

-- Verified 2026-09-18: each exact endpoint returned HTTP 200 and RSS/XML content.
-- State coverage is deliberately limited to WA; registry rows do not imply award coverage.
insert into public.intelligence_shared_sources(id,name,url,enabled,scope,states,verification_url,verified_at,poll_minutes) values
('wa_commerce','Washington Commerce announcements','https://www.commerce.wa.gov/feed/',true,'state_local','{WA}',
 'https://www.commerce.wa.gov/news/media-archive/','2026-09-18T00:00:00Z',60),
('gsa_news','GSA news releases','https://www.gsa.gov/_rssfeed/hq_newsReleases.xml',true,'agency','{}',
 'https://www.gsa.gov/about-gsa/newsroom/rss-feeds','2026-09-18T00:00:00Z',60),
('pr_newswire','PR Newswire company announcements','https://www.prnewswire.com/rss/news-releases-list.rss',true,'industry','{}',
 'https://www.prnewswire.com/rss/','2026-09-18T00:00:00Z',15);

create function public.intelligence_shared_claim(p_source text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare source public.intelligence_shared_sources;
begin
  if not coalesce((select enabled from public.intelligence_config where id=1),false) then return null; end if;
  select s.* into source from public.intelligence_shared_sources s
    where s.id=p_source and s.enabled and s.free_access and s.verified_at is not null
      and s.format in ('rss','atom') and (s.lease_until is null or s.lease_until < now())
      and (s.next_fetch_at <= now() or exists(select 1 from public.intelligence_shared_items i
        where i.source_id=s.id and not i.complete and i.next_attempt_at<=now()))
    for update skip locked;
  if not found then return null; end if;
  update public.intelligence_shared_sources set lease_token=gen_random_uuid(),lease_until=now()+interval '5 minutes',last_attempt_at=now()
    where id=p_source returning * into source;
  return to_jsonb(source);
end $$;

create function public.intelligence_shared_snapshot(p_source text,p_lease uuid,p_items jsonb,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare source public.intelligence_shared_sources; incoming integer; incoming_bytes bigint;
begin
  select * into source from public.intelligence_shared_sources where id=p_source and lease_token=p_lease and lease_until>now() for update;
  if not found then raise exception 'shared_source_lease_lost'; end if;
  if p_error is not null then
    update public.intelligence_shared_sources set last_fetch_status='error',last_fetch_error=left(p_error,200),last_fetch_at=now(),
      next_fetch_at=now()+make_interval(mins=>poll_minutes) where id=p_source;
    return;
  end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>250 then raise exception 'invalid_shared_items'; end if;
  perform pg_advisory_xact_lock(hashtext('intelligence_shared_storage'));
  -- Retain dedupe receipts for 30 days; never delete observations or unresolved work.
  delete from public.intelligence_shared_items where source_id=p_source and complete and completed_at<now()-interval '30 days';
  select count(*) into incoming from jsonb_array_elements(p_items) v
    where not exists(select 1 from public.intelligence_shared_items i where i.source_id=p_source and i.item_key=v->>'item_key');
  select coalesce(sum(octet_length((v->'payload')::text)),0) into incoming_bytes from jsonb_array_elements(p_items) v
    where not exists(select 1 from public.intelligence_shared_items i where i.source_id=p_source and i.item_key=v->>'item_key');
  -- Bounded new storage; a full backlog surfaces an error rather than dropping an item.
  if (select count(*) from public.intelligence_shared_items where source_id=p_source)+incoming>5000 then raise exception 'shared_source_capacity_exceeded'; end if;
  -- Compact intake budget across all sources; reserve room for cached retry bodies.
  if incoming_bytes>0 and (select coalesce(sum(octet_length(payload::text)),0) from public.intelligence_shared_items)+incoming_bytes>2000000 then
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

create function public.intelligence_shared_item(p_source text,p_lease uuid,p_key text,p_payload jsonb default null,
  p_done boolean default false,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  perform 1 from public.intelligence_shared_sources where id=p_source and lease_token=p_lease and lease_until>now() for update;
  if not found then raise exception 'shared_source_lease_lost'; end if;
  if p_payload is not null and not p_done then
    perform pg_advisory_xact_lock(hashtext('intelligence_shared_storage'));
    if (select coalesce(sum(octet_length(payload::text)),0) from public.intelligence_shared_items)
      +octet_length(p_payload::text)-coalesce((select octet_length(payload::text) from public.intelligence_shared_items where source_id=p_source and item_key=p_key),0)>8000000 then
      raise exception 'shared_source_storage_capacity_exceeded';
    end if;
  end if;
  update public.intelligence_shared_items set
    payload=case when p_done then (coalesce(p_payload,payload)-'text'-'sourceDates') else coalesce(p_payload,payload) end,
    complete=p_done,completed_at=case when p_done then now() else null end,
    attempts=attempts+case when p_error is null then 0 else 1 end,
    next_attempt_at=case when p_error is null then now() else now()+make_interval(mins=>least(1440,15*(attempts+1))) end,
    last_error=left(p_error,200)
    where source_id=p_source and item_key=p_key and not complete;
  if not found then raise exception 'shared_item_missing_or_complete'; end if;
end $$;

create function public.intelligence_shared_release(p_source text,p_lease uuid,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  update public.intelligence_shared_sources set lease_token=null,lease_until=null,last_work_error=left(p_error,200)
    where id=p_source and lease_token=p_lease;
  if not found then raise exception 'shared_source_lease_lost'; end if;
end $$;

do $$ declare t text; f record;
begin
  foreach t in array array['intelligence_shared_sources','intelligence_shared_items'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('intelligence_shared_claim','intelligence_shared_snapshot','intelligence_shared_item','intelligence_shared_release') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
