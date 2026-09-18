-- Shared public intelligence. No TAM membership, grading, or federal cursor writes.
begin;

create table public.intelligence_config (
  id integer primary key check (id = 1),
  enabled boolean not null default false,
  monthly_limit_usd numeric(12,6) not null default 20 check (monthly_limit_usd between 0 and 20),
  jev_limit_usd numeric(12,6) not null default 10 check (jev_limit_usd between 0 and 20),
  generation_limit_usd numeric(12,6) not null default 5 check (generation_limit_usd between 0 and 20),
  updated_at timestamptz not null default now()
);
insert into public.intelligence_config(id) values (1);

create table public.intelligence_observations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id),
  source_key text not null,
  source_kind text not null check (source_kind in ('news','website','job','government')),
  source_url text not null,
  title text not null,
  evidence_text text not null check (length(evidence_text) between 1 and 48000),
  content_hash text not null,
  event_date timestamptz,
  observed_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  is_current boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  sections jsonb not null default '[]'::jsonb,
  attributes jsonb,
  interpretation_version text,
  interpreted_at timestamptz,
  unique(company_id, source_key, content_hash)
);
create index intelligence_observations_account on public.intelligence_observations(company_id, observed_at desc);
create index intelligence_observations_current on public.intelligence_observations(observed_at desc) where is_current;

create table public.intelligence_views (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 120),
  question text not null unique check (length(question) between 8 and 1200),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  -- Keyset backfill cursor is advanced transactionally with enqueuing a page.
  backfill_after uuid,
  backfill_complete boolean not null default false
);
-- Reopening a saved question must revisit evidence received while it was archived.
-- Backfill enqueues idempotently, retaining already completed matches.
create function public.intelligence_reactivate_view()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  new.backfill_after := null;
  new.backfill_complete := false;
  return new;
end $$;
create trigger intelligence_view_reactivation before update of active on public.intelligence_views
  for each row when (not old.active and new.active)
  execute function public.intelligence_reactivate_view();
create table public.intelligence_view_matches (
  view_id uuid not null references public.intelligence_views(id) on delete cascade,
  observation_id uuid not null references public.intelligence_observations(id),
  probability double precision not null check (probability between 0 and 1),
  evaluated_at timestamptz not null default now(),
  primary key(view_id, observation_id)
);

create table public.intelligence_jobs (
  id uuid primary key default gen_random_uuid(),
  operation_key text not null unique,
  observation_id uuid not null references public.intelligence_observations(id),
  view_id uuid references public.intelligence_views(id),
  kind text not null check (kind in ('interpret','view')),
  status text not null default 'queued' check (status in ('queued','running','complete','failed','superseded')),
  priority integer not null default 0,
  due_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check ((kind='view') = (view_id is not null))
);
create index intelligence_jobs_due on public.intelligence_jobs(due_at, priority desc, created_at) where status in ('queued','running');

create table public.intelligence_spend (
  id uuid primary key,
  month date not null,
  category text not null check (category in ('jev','generation')),
  reserved_usd numeric(12,6) not null check (reserved_usd > 0),
  charged_usd numeric(12,6),
  input_tokens bigint,
  state text not null default 'reserved' check (state in ('reserved','settled')),
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check (charged_usd is null or charged_usd >= 0)
);
create index intelligence_spend_month on public.intelligence_spend(month, category);

create table public.intelligence_source_state (
  company_id uuid not null references public.companies(id),
  source_key text not null,
  cursor jsonb,
  complete boolean not null default false,
  last_attempt_at timestamptz not null default now(),
  last_success_at timestamptz,
  last_error text,
  primary key(company_id, source_key)
);

create table public.intelligence_feedback (
  company_id uuid not null references public.companies(id),
  observation_id uuid not null references public.intelligence_observations(id),
  reason text not null check (reason in ('useful','wrong_company','old_event','irrelevant','not_now')),
  note text not null default '' check (length(note) <= 600),
  updated_at timestamptz not null default now(),
  primary key(company_id, observation_id)
);

-- Source-key lock keeps current-version changes and work creation atomic even
-- when collectors race. Seen content reuses its stored annotations.
create function public.intelligence_observe(p_company uuid, p_source_key text, p_source_kind text,
  p_url text, p_title text, p_text text, p_hash text, p_event_date timestamptz,
  p_observed_at timestamptz, p_metadata jsonb, p_sections jsonb, p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_queued boolean := false;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then
    return jsonb_build_object('disabled',true);
  end if;
  if not exists(select 1 from companies where id=p_company and status <> 'removed_from_tam') then
    raise exception 'Account is not eligible for intelligence';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || p_source_key,0));
  update intelligence_observations set is_current=false
    where company_id=p_company and source_key=p_source_key and content_hash<>p_hash and is_current;
  insert into intelligence_observations(company_id,source_key,source_kind,source_url,title,evidence_text,
    content_hash,event_date,observed_at,metadata,sections)
  values(p_company,p_source_key,p_source_kind,p_url,p_title,p_text,p_hash,p_event_date,p_observed_at,p_metadata,p_sections)
  on conflict(company_id,source_key,content_hash) do update
    set last_seen_at=now(),is_current=true
  returning id into v_id;
  insert into intelligence_jobs(operation_key,observation_id,kind,priority)
    values('interpret:' || v_id || ':' || p_version,v_id,'interpret',case when p_event_date between now()-interval '7 days' and now() then 30 else 10 end)
    on conflict(operation_key) do update set status='queued',due_at=now(),attempts=0,
      lease_token=null,lease_until=null,last_error=null,finished_at=null
      where intelligence_jobs.status='superseded';
  v_queued := found;
  insert into intelligence_jobs(operation_key,observation_id,view_id,kind,priority)
    select 'view:' || v.id || ':' || v_id,v_id,v.id,'view',0 from intelligence_views v where v.active
    on conflict(operation_key) do update set status='queued',due_at=now(),attempts=0,
      lease_token=null,lease_until=null,last_error=null,finished_at=null
      where intelligence_jobs.status='superseded';
  return jsonb_build_object('id',v_id,'queued',v_queued);
end $$;

-- One oldest due job guarantees backfill progress; remaining slots favor fresh
-- evidence so a historical corpus scan cannot hold new opportunities behind it.
-- Claims are
-- fenced: only the current lease token can complete or defer the operation.
create function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then return; end if;
  update intelligence_jobs set status='failed',last_error='attempts_exhausted',lease_token=null,lease_until=null
    where attempts>=5 and (status='queued' or (status='running' and lease_until<now()));
  return query
    with oldest as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now()
        and (status='queued' or (status='running' and lease_until<now()))
      order by due_at,priority desc,created_at,id
      for update skip locked limit 1
    ), fresh as materialized (
      select id from intelligence_jobs
      where attempts<5 and due_at<=now() and id not in(select id from oldest)
        and (status='queued' or (status='running' and lease_until<now()))
      order by priority desc,due_at,created_at,id
      for update skip locked limit greatest(0,least(p_limit,12)-1)
    ), ready as (
      select id from oldest union all select id from fresh
    ) update intelligence_jobs j set status='running',attempts=j.attempts+1,
      lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
      from ready where j.id=ready.id returning j.*;
end $$;

create function public.intelligence_finish(p_id uuid,p_lease uuid,p_status text,p_result jsonb,
  p_attributes jsonb default null,p_version text default null,p_probability double precision default null,
  p_error text default null,p_retry_seconds integer default 300)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare j intelligence_jobs%rowtype;
begin
  select * into j from intelligence_jobs where id=p_id and status='running'
    and lease_token=p_lease and lease_until>now() for update;
  if not found then return false; end if;
  if p_status not in ('complete','queued','failed','superseded') then raise exception 'Invalid job outcome'; end if;
  if p_status='complete' and j.kind='interpret' then
    if p_attributes is null or p_version is null then raise exception 'Missing interpretation'; end if;
    update intelligence_observations set attributes=p_attributes,interpretation_version=p_version,interpreted_at=now()
      where id=j.observation_id;
  elsif p_status='complete' and j.kind='view' then
    if p_probability is null or p_probability<0 or p_probability>1 then raise exception 'Missing match probability'; end if;
    insert into intelligence_view_matches(view_id,observation_id,probability)
      values(j.view_id,j.observation_id,p_probability)
      on conflict(view_id,observation_id) do update set probability=excluded.probability,evaluated_at=now();
  end if;
  update intelligence_jobs set status=p_status,result=p_result,last_error=left(p_error,200),
    due_at=case when p_status='queued' then now()+make_interval(secs=>greatest(30,least(p_retry_seconds,2678400))) else due_at end,
    -- Normal progress and configuration/budget deferrals are not provider failures.
    attempts=case when p_status='queued' and p_error in ('budget_deferred','intelligence_disabled','continuation') then greatest(attempts-1,0) else attempts end,
    lease_token=null,lease_until=null,finished_at=case when p_status='queued' then null else now() end
    where id=j.id;
  return true;
end $$;

create function public.intelligence_reserve(p_id uuid,p_category text,p_amount numeric)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare c intelligence_config%rowtype; v_month date := date_trunc('month',now() at time zone 'UTC')::date;
  v_total numeric; v_category numeric; v_limit numeric;
begin
  if p_category not in ('jev','generation') or p_amount<=0 or p_amount>1 then raise exception 'Invalid reservation'; end if;
  select * into c from intelligence_config where id=1 for update;
  if not c.enabled then return false; end if;
  -- Never redispatch an idempotency key after an uncertain provider acceptance.
  if exists(select 1 from intelligence_spend where id=p_id) then return false; end if;
  select coalesce(sum(coalesce(charged_usd,reserved_usd)),0),
    coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where category=p_category),0)
    into v_total,v_category from intelligence_spend where month=v_month;
  v_limit := case when p_category='jev' then c.jev_limit_usd else c.generation_limit_usd end;
  if v_total+p_amount>c.monthly_limit_usd or v_category+p_amount>v_limit then return false; end if;
  insert into intelligence_spend(id,month,category,reserved_usd) values(p_id,v_month,p_category,p_amount);
  return true;
end $$;

create function public.intelligence_settle(p_id uuid,p_actual numeric,p_tokens bigint default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_actual is not null and p_actual<0 then raise exception 'Invalid actual cost'; end if;
  -- Unknown usage retains the conservative reservation, including accepted calls
  -- whose response was lost. Reservations are never automatically released.
  update intelligence_spend set charged_usd=coalesce(p_actual,reserved_usd),input_tokens=p_tokens,
    state='settled',settled_at=now() where id=p_id and state='reserved';
  return found;
end $$;

create function public.intelligence_backfill_view(p_view uuid,p_limit integer default 100)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare v intelligence_views%rowtype; o record; v_count integer:=0; v_last uuid;
begin
  select * into v from intelligence_views where id=p_view and active for update;
  if not found or v.backfill_complete then return 0; end if;
  for o in select id from intelligence_observations where is_current
    and (v.backfill_after is null or id>v.backfill_after) order by id limit greatest(1,least(p_limit,200))
  loop
    insert into intelligence_jobs(operation_key,observation_id,view_id,kind)
      values('view:'||p_view||':'||o.id,o.id,p_view,'view')
      on conflict(operation_key) do update set status='queued',due_at=now(),attempts=0,
        lease_token=null,lease_until=null,last_error=null,finished_at=null
        where intelligence_jobs.status='superseded';
    v_count:=v_count+1; v_last:=o.id;
  end loop;
  update intelligence_views set backfill_after=coalesce(v_last,backfill_after),
    backfill_complete=(v_count<greatest(1,least(p_limit,200))) where id=p_view;
  return v_count;
end $$;

-- Candidate review gains leases/backoff while retaining its independent verifier.
alter table public.trigger_candidates add column review_due_at timestamptz not null default now(),
  add column review_attempts integer not null default 0,
  add column review_lease_token uuid,
  add column review_lease_until timestamptz,
  add column review_last_error text;
create index trigger_candidates_due on public.trigger_candidates(review_due_at,created_at)
  where verdict is null or (verdict='keep' and promoted_trigger_id is null);
create function public.intelligence_status()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'enabled',(select enabled from intelligence_config where id=1),
    'spend',jsonb_build_object(
      'usedUsd',(select coalesce(sum(charged_usd),0) from intelligence_spend where month=date_trunc('month',now() at time zone 'UTC')::date),
      'reservedUsd',(select coalesce(sum(reserved_usd),0) from intelligence_spend where state='reserved' and month=date_trunc('month',now() at time zone 'UTC')::date),
      'limitUsd',(select monthly_limit_usd from intelligence_config where id=1)),
    'jobs',jsonb_build_object(
      'queued',(select count(*) from intelligence_jobs where status='queued'),
      'running',(select count(*) from intelligence_jobs where status='running'),
      'failed',(select count(*) from intelligence_jobs where status='failed')),
    'sourceCoverage',jsonb_build_object(
      'complete',(select count(*) from intelligence_source_state where complete and last_error is null),
      'partial',(select count(*) from intelligence_source_state where not complete and last_error is null),
      'failed',(select count(*) from intelligence_source_state where last_error is not null))
  );
$$;

create function public.intelligence_claim_candidates(p_limit integer default 12)
returns setof public.trigger_candidates language plpgsql security definer set search_path=public,pg_temp as $$
begin
  return query with ready as (
    select id from trigger_candidates where (verdict is null or (verdict='keep' and promoted_trigger_id is null)) and review_due_at<=now()
      and (review_lease_until is null or review_lease_until<now())
    order by review_due_at,created_at for update skip locked limit greatest(1,least(p_limit,24))
  ) update trigger_candidates c set review_lease_token=gen_random_uuid(),
    review_lease_until=now()+interval '4 minutes',review_attempts=c.review_attempts+1
    from ready where c.id=ready.id returning c.*;
end $$;

do $$ declare t text; f record;
begin
  foreach t in array array['intelligence_config','intelligence_observations','intelligence_views',
    'intelligence_view_matches','intelligence_jobs','intelligence_spend','intelligence_source_state','intelligence_feedback']
  loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('intelligence_observe','intelligence_claim','intelligence_finish',
      'intelligence_reserve','intelligence_settle','intelligence_backfill_view','intelligence_claim_candidates','intelligence_status','intelligence_reactivate_view')
  loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;

notify pgrst, 'reload schema';
commit;
