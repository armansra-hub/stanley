-- New-source research uses the same per-URL leases and spend budget as refreshes.
-- No membership or grade writes and no replay of already-paid interpretations.
begin;
create table public.intelligence_research_sources (
  company_id uuid not null references public.companies(id),
  source_url text not null check(length(source_url)<=2048 and source_url ~ '^https?://'),
  title text not null default '',
  discovered_from text not null,
  discovered_at timestamptz not null default now(),
  primary key(company_id,source_url)
);
alter table public.intelligence_research_sources enable row level security;
revoke all on public.intelligence_research_sources from public,anon,authenticated;
grant all on public.intelligence_research_sources to service_role;

create or replace function public.intelligence_directed_refresh(p_company uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare fingerprint text; interpreted boolean; links text;
begin
  perform pg_advisory_xact_lock(hashtextextended('directed-research:'||p_company::text,0));
  if not exists(select 1 from companies where id=p_company and status<>'removed_from_tam'
    and lists @> array['netsuite_tam']::text[] and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
    and netsuite_internal_id ~ '^[0-9]+$') then return false; end if;
  select count(*)>0,coalesce(string_agg(id::text||':'||content_hash||':'||cached_operating_topics::text,',' order by id),'')
    into interpreted,fingerprint from intelligence_observations
    where company_id=p_company and is_current and not feedback_excluded and attributes is not null;
  -- A useful first pass may have unknown topics; unknown is a reason to research,
  -- not a reason to require another model judgment before allowing research.
  if not interpreted then
    update intelligence_directed_research_jobs set status='superseded',lease_token=null,lease_until=null,
      finished_at=now(),last_error='no_current_evidence' where company_id=p_company and status in ('queued','running');
    return false;
  end if;
  select coalesce((cursor->'verifiedUrls')::text,'[]')||coalesce((cursor->'knownUrls')::text,'[]')||
    coalesce((cursor->'pendingUrls')::text,'[]') into links from intelligence_source_state
    where company_id=p_company and source_key='website';
  fingerprint:=md5('discovered-business-services-v2:'||fingerprint||coalesce(links,'[]')||coalesce(
    (select string_agg(source_url,',' order by source_url) from intelligence_research_sources where company_id=p_company),''));
  insert into intelligence_directed_research_jobs(company_id,desired_hash) values(p_company,fingerprint)
  on conflict(company_id) do update set desired_hash=excluded.desired_hash,status='queued',requested_at=now(),due_at=now(),
    lease_token=null,lease_until=null,attempts=0,last_error=null,finished_at=null
    where (intelligence_directed_research_jobs.desired_hash<>excluded.desired_hash
      or intelligence_directed_research_jobs.status='superseded')
      and not (intelligence_directed_research_jobs.status='running' and intelligence_directed_research_jobs.lease_until>now());
  return found;
end $$;

-- Seed from existing interpreted accounts only. The bounded worker discovers new
-- evidence; this does not rerun existing sources through Jev.
do $$ declare account uuid; begin
  for account in select distinct company_id from intelligence_observations where is_current and not feedback_excluded and attributes is not null
  loop perform intelligence_directed_refresh(account); end loop;
end $$;
notify pgrst,'reload schema';
commit;
