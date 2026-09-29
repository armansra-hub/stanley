-- Codex-authored customer research. Full page bodies stay in the private local
-- evidence archive; this table holds compact manifests and exact quoted proof.
-- Registry imports and native Jev answers retain their independent status/history.
begin;
create table if not exists public.intelligence_customer_research_profiles (
 customer_id text primary key references public.intelligence_customer_reference_registry(id),
 full_profile_sha256 text not null check (full_profile_sha256 ~ '^[a-f0-9]{64}$'),
 research_status text not null check (research_status in ('draft','in_progress','complete','complete_with_gaps','unresolved')),
 profile jsonb not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (coalesce(profile->>'schema'='customer-research-proof-v1',false)),
 check (coalesce(profile->>'sourceStorage'='private_local_full_text',false)),
 check (coalesce(profile->>'customerId'=customer_id,false)),
 check (coalesce(profile->>'fullProfileSha256'=full_profile_sha256,false)),
 check (coalesce(profile->>'status'=research_status,false)),
 check (coalesce(profile->'author'->>'kind'='codex',false)),
 check (jsonb_typeof(profile->'sources')='array' and jsonb_typeof(profile->'facts')='array')
);
alter table public.intelligence_customer_research_profiles enable row level security;
revoke all on public.intelligence_customer_research_profiles from public,anon,authenticated;
grant select,insert,update on public.intelligence_customer_research_profiles to service_role;

-- Library versions are immutable snapshots. Draft storage never activates Jev.
-- No promotion function or scheduler is installed by this migration.
create table if not exists public.intelligence_customer_research_taxonomies (
 id text not null,
 version text not null check (version ~ '^[a-f0-9]{64}$'),
 status text not null check (status in ('draft','approved')),
 taxonomy jsonb not null,
 created_at timestamptz not null default now(),
 primary key (id,version),
 check (coalesce(taxonomy->>'schema'='customer-characteristics-v1',false)),
 check (coalesce(taxonomy->>'id'=id,false)),
 check (coalesce(taxonomy->>'status'=status,false)),
 check (coalesce(taxonomy->'author'->>'kind'='codex',false))
);
alter table public.intelligence_customer_research_taxonomies enable row level security;
revoke all on public.intelligence_customer_research_taxonomies from public,anon,authenticated;
grant select,insert on public.intelligence_customer_research_taxonomies to service_role;

create or replace function public.intelligence_customer_research_put(
 p_profile jsonb,p_expected_hash text default null,p_registry_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp set jit=off as $$
declare target_id text; registry intelligence_customer_reference_registry%rowtype;
 previous intelligence_customer_research_profiles%rowtype; new_hash text;
begin
 target_id=p_profile->>'customerId'; new_hash=p_profile->>'fullProfileSha256';
 if target_id is null or target_id !~ '^[a-zA-Z0-9_.-]{1,160}$'
  or not coalesce(p_profile->>'schema'='customer-research-proof-v1',false)
  or not coalesce(p_profile->>'sourceStorage'='private_local_full_text',false)
  or not coalesce(p_profile->'author'->>'kind'='codex',false)
  or new_hash is null or new_hash !~ '^[a-f0-9]{64}$'
  or not coalesce(p_profile->>'status' in ('draft','in_progress','complete','complete_with_gaps','unresolved'),false)
  or jsonb_typeof(p_profile->'sources') is distinct from 'array'
  or jsonb_typeof(p_profile->'facts') is distinct from 'array'
  or jsonb_typeof(p_profile->'announcementIds') is distinct from 'array'
  then raise exception 'Invalid customer research proof'; end if;
 if exists(select 1 from jsonb_array_elements(p_profile->'sources') source where source ? 'text')
  or exists(select 1 from jsonb_array_elements(p_profile->'facts') fact where fact ? 'nativeResult'
   or not coalesce(fact->>'origin'='codex_research',false))
  or p_profile ? 'nativeResult' or p_profile ? 'tamScore'
  then raise exception 'Only compact authored customer proof is allowed'; end if;
 -- An unresolved attempt counts as accounted for, never as researched. The
 -- source validator still checks every retained citation against full text.
 if p_profile->>'status'='unresolved' and (
  nullif(btrim(p_profile->>'completedAt'),'') is null
  or nullif(btrim(p_profile->>'summary'),'') is null
  or not coalesce(p_profile->'discovery'->>'status'='complete',false)
  or jsonb_typeof(p_profile->'discovery'->'methods') is distinct from 'array'
  or jsonb_array_length(p_profile->'discovery'->'methods')=0
  or jsonb_typeof(p_profile->'sourceGaps') is distinct from 'array'
  or jsonb_array_length(p_profile->'sourceGaps')=0
  or not coalesce(p_profile->'coverage'->>'pending'='0',false)
  or not coalesce(p_profile->'coverage'->>'unread'='0',false)
 ) then raise exception 'Unresolved customer research needs documented finished discovery and gaps'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_id,7935));
 select * into registry from intelligence_customer_reference_registry where id=target_id and active for update;
 if not found then raise exception 'Customer registry identity changed'; end if;
 if p_registry_updated_at is null or registry.updated_at<>p_registry_updated_at or registry.name<>p_profile->>'name'
  or (select coalesce(jsonb_agg(value order by value),'[]') from jsonb_array_elements(p_profile->'announcementIds'))
   is distinct from (select coalesce(jsonb_agg(a->'id' order by a->'id'),'[]') from jsonb_array_elements(registry.announcements) a)
  then raise exception 'Customer registry identity changed'; end if;
 select * into previous from intelligence_customer_research_profiles where customer_id=target_id for update;
 if found then
  if previous.full_profile_sha256=new_hash then
   return jsonb_build_object('customerId',target_id,'fullProfileSha256',new_hash,'unchanged',true);
  end if;
  if p_expected_hash is null or previous.full_profile_sha256<>p_expected_hash then raise exception 'Customer research write conflict'; end if;
  update intelligence_customer_research_profiles set full_profile_sha256=new_hash,research_status=p_profile->>'status',
   profile=p_profile,updated_at=now() where customer_id=target_id;
 else
  if p_expected_hash is not null then raise exception 'Customer research write conflict'; end if;
  insert into intelligence_customer_research_profiles(customer_id,full_profile_sha256,research_status,profile)
   values(target_id,new_hash,p_profile->>'status',p_profile);
 end if;
 return jsonb_build_object('customerId',target_id,'fullProfileSha256',new_hash,'unchanged',false);
end $$;

create or replace function public.intelligence_customer_research_progress()
returns jsonb language sql stable security definer set search_path=public,pg_temp set jit=off as $$
 select jsonb_build_object('total',count(*),
  'started',count(*) filter(where p.research_status in ('in_progress','complete','complete_with_gaps','unresolved')),
  'notStarted',count(*) filter(where p.customer_id is null),
  'draft',count(*) filter(where p.research_status='draft'),
  'inProgress',count(*) filter(where p.research_status='in_progress'),
  'complete',count(*) filter(where p.research_status='complete'),
  'completeWithGaps',count(*) filter(where p.research_status='complete_with_gaps'),
  'unresolved',count(*) filter(where p.research_status='unresolved'),
  'facts',coalesce(sum(jsonb_array_length(p.profile->'facts')),0),
  'readPages',coalesce(sum((p.profile->'coverage'->>'read')::integer),0),
  'pendingPages',coalesce(sum((p.profile->'coverage'->>'pending')::integer),0),
  'unreadPages',coalesce(sum((p.profile->'coverage'->>'unread')::integer),0),
  'unavailablePages',coalesce(sum((p.profile->'coverage'->>'unavailable')::integer),0),
  'latestUpdatedAt',max(p.updated_at),'origin','codex_research','providerCalls',0)
 from intelligence_customer_reference_registry r left join intelligence_customer_research_profiles p on p.customer_id=r.id
 where r.active;
$$;
revoke all on function public.intelligence_customer_research_put(jsonb,text,timestamptz) from public,anon,authenticated;
revoke all on function public.intelligence_customer_research_progress() from public,anon,authenticated;
grant execute on function public.intelligence_customer_research_put(jsonb,text,timestamptz) to service_role;
grant execute on function public.intelligence_customer_research_progress() to service_role;
notify pgrst,'reload schema';
commit;
