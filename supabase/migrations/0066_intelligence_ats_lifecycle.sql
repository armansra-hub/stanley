-- Public ATS listing lifecycle. Only a complete, contiguous scan can establish
-- disappearance or a pace baseline. No grades, CRM facts or Jev answers change.
begin;
create table public.intelligence_ats_boards (
  company_id uuid not null references public.companies(id),
  source_key text not null check(length(source_key) between 5 and 220),
  active_scan_id uuid,
  next_offset integer not null default 0 check(next_offset>=0),
  revision bigint not null default 0,
  snapshot_key text,
  expected_total integer,
  last_complete_at timestamptz,
  last_attempt_at timestamptz not null default now(),
  last_error text,
  primary key(company_id,source_key)
);
create table public.intelligence_ats_scans (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source_key text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  previous_complete_at timestamptz,
  status text not null default 'collecting' check(status in ('collecting','complete','superseded')),
  pattern_status text not null default 'pending' check(pattern_status in ('pending','none','enqueued')),
  pattern_observation_id uuid,
  summary jsonb
);
create index intelligence_ats_scans_recent on public.intelligence_ats_scans(company_id,completed_at desc) where status='complete';
create table public.intelligence_ats_jobs (
  company_id uuid not null references public.companies(id),
  source_key text not null,
  job_key text not null check(length(job_key)=64),
  provider_id text,
  url text not null,
  title text not null,
  location text not null default '',
  source_date timestamptz,
  listing_hash text not null check(length(listing_hash)=64),
  content_hash text not null check(length(content_hash)=64),
  confirmed_hash text,
  categories text[] not null default '{}',
  client_placement boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_seen_scan_id uuid not null,
  confirmed_open boolean not null default false,
  first_confirmed_at timestamptz,
  expired_at timestamptz,
  last_transition text check(last_transition in ('baseline','new','changed','reopened','expired','unchanged')),
  last_transition_scan_id uuid,
  primary key(company_id,source_key,job_key)
);
create index intelligence_ats_jobs_scan on public.intelligence_ats_jobs(company_id,source_key,last_seen_scan_id);

create function public.intelligence_ats_apply_batch(
  p_company uuid,p_source_key text,p_scan_id uuid,p_offset integer,p_next_offset integer,
  p_complete boolean,p_available boolean,p_snapshot_key text,p_expected_total integer,p_jobs jsonb,p_revision bigint default 0
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare b intelligence_ats_boards%rowtype; s uuid; j jsonb; v_summary jsonb; roles jsonb;
  change_rows jsonb; total integer; added integer; changed integer; reopened integer; expired integer;
  baseline boolean; elapsed numeric; previous_rate numeric; new_operating integer; new_roles jsonb; v_now timestamptz:=now();
begin
  if p_company is null or p_source_key is null or p_offset is null or p_offset<0 or p_source_key not like 'ats:%' or length(p_source_key)>220
    or p_jobs is null or jsonb_typeof(p_jobs)<>'array' or jsonb_array_length(p_jobs)>500
    or p_complete is null or p_available is null or (p_complete and not p_available)
    or (p_complete and (p_expected_total is null or p_expected_total<0))
    or (not p_complete and (p_next_offset is null or p_next_offset<p_offset)) then
    raise exception 'Invalid ATS batch';
  end if;
  insert into intelligence_ats_boards(company_id,source_key) values(p_company,p_source_key) on conflict do nothing;
  select * into b from intelligence_ats_boards where company_id=p_company and source_key=p_source_key for update;
  if p_revision is null or b.revision<>p_revision or b.active_scan_id is distinct from p_scan_id or b.next_offset<>p_offset then
    return jsonb_build_object('accepted',false,'reason','cursor_changed');
  end if;
  update intelligence_ats_boards set revision=revision+1,last_attempt_at=v_now,last_error=case when p_available then null else 'provider_unavailable' end
    where company_id=p_company and source_key=p_source_key;
  if not p_available then
    return jsonb_build_object('accepted',true,'complete',false,'scanId',b.active_scan_id,'nextOffset',b.next_offset);
  end if;
  if (b.snapshot_key is not null and p_snapshot_key is distinct from b.snapshot_key)
     or (b.expected_total is not null and p_expected_total is not null and p_expected_total<>b.expected_total)
     or (b.active_scan_id is not null and exists(select 1 from intelligence_ats_jobs
       where company_id=p_company and source_key=p_source_key and last_seen_scan_id=b.active_scan_id
         and job_key in (select value->>'job_key' from jsonb_array_elements(p_jobs)))) then
    update intelligence_ats_scans set status='superseded' where id=b.active_scan_id;
    update intelligence_ats_boards set active_scan_id=null,next_offset=0,snapshot_key=null,expected_total=null,last_error='board_changed_during_scan'
      where company_id=p_company and source_key=p_source_key;
    return jsonb_build_object('accepted',true,'complete',false,'restart',true,'scanId',null,'nextOffset',0);
  end if;
  s:=b.active_scan_id;
  if s is null then
    if p_offset<>0 then raise exception 'ATS scan must begin at zero'; end if;
    insert into intelligence_ats_scans(company_id,source_key,previous_complete_at)
      values(p_company,p_source_key,b.last_complete_at) returning id into s;
  end if;
  if (select count(*) from jsonb_array_elements(p_jobs))<>(select count(distinct value->>'job_key') from jsonb_array_elements(p_jobs)) then
    raise exception 'Duplicate job identity in ATS batch';
  end if;
  for j in select value from jsonb_array_elements(p_jobs) loop
    if j->>'job_key' !~ '^[0-9a-f]{64}$' or j->>'content_hash' !~ '^[0-9a-f]{64}$'
      or j->>'listing_hash' !~ '^[0-9a-f]{64}$' or coalesce(length(j->>'title'),0)=0
      or coalesce(j->>'url','') !~ '^https?://' then raise exception 'Malformed ATS job'; end if;
    insert into intelligence_ats_jobs(company_id,source_key,job_key,provider_id,url,title,location,source_date,
      listing_hash,content_hash,categories,client_placement,last_seen_scan_id)
    values(p_company,p_source_key,j->>'job_key',j->>'provider_id',j->>'url',left(j->>'title',500),left(coalesce(j->>'location',''),500),
      nullif(j->>'source_date','')::timestamptz,j->>'listing_hash',j->>'content_hash',
      array(select jsonb_array_elements_text(j->'categories')),coalesce((j->>'client_placement')::boolean,false),s)
    on conflict(company_id,source_key,job_key) do update set
      provider_id=excluded.provider_id,url=excluded.url,title=excluded.title,location=excluded.location,source_date=excluded.source_date,
      listing_hash=excluded.listing_hash,content_hash=excluded.content_hash,categories=excluded.categories,
      client_placement=excluded.client_placement,last_seen_scan_id=s,last_seen_at=v_now;
  end loop;
  update intelligence_ats_boards set active_scan_id=s,next_offset=coalesce(p_next_offset,0),
    snapshot_key=coalesce(snapshot_key,p_snapshot_key),expected_total=coalesce(expected_total,p_expected_total)
    where company_id=p_company and source_key=p_source_key;
  if not p_complete then return jsonb_build_object('accepted',true,'complete',false,'scanId',s,'nextOffset',p_next_offset); end if;
  select count(*) into total from intelligence_ats_jobs where company_id=p_company and source_key=p_source_key and last_seen_scan_id=s;
  if coalesce(p_expected_total,b.expected_total) is not null and total<>coalesce(p_expected_total,b.expected_total) then
    update intelligence_ats_scans set status='superseded' where id=s;
    update intelligence_ats_boards set active_scan_id=null,next_offset=0,snapshot_key=null,expected_total=null,last_error='incomplete_identity_coverage'
      where company_id=p_company and source_key=p_source_key;
    return jsonb_build_object('accepted',true,'complete',false,'restart',true,'scanId',null,'nextOffset',0);
  end if;
  baseline:=b.last_complete_at is null;
  update intelligence_ats_jobs set last_transition=case
    when last_seen_scan_id=s and baseline then 'baseline'
    when last_seen_scan_id=s and first_confirmed_at is null then 'new'
    when last_seen_scan_id=s and not confirmed_open then 'reopened'
    when last_seen_scan_id=s and confirmed_hash is distinct from content_hash then 'changed'
    when last_seen_scan_id=s then 'unchanged'
    else 'expired' end,last_transition_scan_id=s
    where company_id=p_company and source_key=p_source_key and (last_seen_scan_id=s or confirmed_open);
  select count(*) filter(where last_transition='new'),count(*) filter(where last_transition='changed'),
    count(*) filter(where last_transition='reopened'),count(*) filter(where last_transition='expired')
    into added,changed,reopened,expired from intelligence_ats_jobs
    where company_id=p_company and source_key=p_source_key and last_transition_scan_id=s;
  select coalesce(jsonb_object_agg(category,n),'{}') into roles from (
    select category,count(*) as n from intelligence_ats_jobs cross join lateral unnest(categories) category
    where company_id=p_company and source_key=p_source_key and last_seen_scan_id=s and not client_placement group by category
  ) r;
  select coalesce(jsonb_agg(value),'[]') into change_rows from (
    select jsonb_build_object('jobKey',job_key,'url',url,'title',title,'kind',last_transition,'categories',categories,'clientPlacement',client_placement) value
    from intelligence_ats_jobs where company_id=p_company and source_key=p_source_key and last_transition_scan_id=s
      and last_transition not in ('baseline','unchanged') order by job_key limit 200
  ) changes;
  elapsed:=case when baseline then null else extract(epoch from(v_now-b.last_complete_at))/86400 end;
  select (summary->>'newListingsPerDay')::numeric into previous_rate from intelligence_ats_scans
    where company_id=p_company and source_key=p_source_key and status='complete' order by completed_at desc limit 1;
  select count(*) into new_operating from intelligence_ats_jobs where company_id=p_company and source_key=p_source_key
    and last_transition_scan_id=s and last_transition in ('new','reopened') and cardinality(categories)>0 and not client_placement;
  select coalesce(jsonb_object_agg(category,n),'{}') into new_roles from (
    select category,count(*) as n from intelligence_ats_jobs cross join lateral unnest(categories) category
    where company_id=p_company and source_key=p_source_key and last_transition_scan_id=s
      and last_transition in ('new','reopened') and not client_placement group by category
  ) r;
  v_summary:=jsonb_build_object('baseline',baseline,'openJobs',total,'newJobs',added,'changedJobs',changed,'reopenedJobs',reopened,
    'expiredJobs',expired,'roleCounts',roles,'changes',change_rows,'changesTruncated',(added+changed+reopened+expired)>200,
    'previousCompleteAt',b.last_complete_at,'completedAt',v_now,'intervalDays',elapsed,
    'newListingsPerDay',case when elapsed>=1 then round(added/elapsed,3) else null end,
    'previousListingsPerDay',previous_rate,'paceChangeRatio',case when elapsed>=1 and previous_rate>0 then round((added/elapsed)/previous_rate,3) else null end,
    'newOperatingJobs',new_operating,'newOperatingRoleCounts',new_roles,
    'paceBasis','newly observed listings between complete scans; not hires or employer posting dates');
  update intelligence_ats_jobs set confirmed_open=last_seen_scan_id=s,
    confirmed_hash=case when last_seen_scan_id=s then content_hash else confirmed_hash end,
    first_confirmed_at=case when last_seen_scan_id=s then coalesce(first_confirmed_at,v_now) else first_confirmed_at end,
    expired_at=case when last_seen_scan_id=s then null when confirmed_open then v_now else expired_at end
    where company_id=p_company and source_key=p_source_key and (last_seen_scan_id=s or confirmed_open);
  update intelligence_ats_scans set status='complete',completed_at=v_now,summary=v_summary where id=s;
  update intelligence_ats_boards set active_scan_id=null,next_offset=0,snapshot_key=null,expected_total=null,last_complete_at=v_now,last_error=null
    where company_id=p_company and source_key=p_source_key;
  return jsonb_build_object('accepted',true,'complete',true,'scanId',s,'nextOffset',null,'summary',v_summary);
end $$;

do $$ declare t text;
begin
  foreach t in array array['intelligence_ats_boards','intelligence_ats_scans','intelligence_ats_jobs'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
end $$;
revoke all on function public.intelligence_ats_apply_batch(uuid,text,uuid,integer,integer,boolean,boolean,text,integer,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.intelligence_ats_apply_batch(uuid,text,uuid,integer,integer,boolean,boolean,text,integer,jsonb,bigint) to service_role;
notify pgrst,'reload schema';
commit;
