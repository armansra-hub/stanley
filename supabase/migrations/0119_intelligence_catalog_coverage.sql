-- Versioned public operating coverage, owned by the existing research lease.
-- No membership/grading queue, activation, bulk admission or provider dispatch.
begin;
alter table public.intelligence_config
  add column catalog_mode text not null default 'off' check(catalog_mode in ('off','pilot','rollout')),
  add column catalog_pilot_company_id uuid references public.companies(id),
  add column catalog_legacy_cutoff_at timestamptz not null default now(),
  add column catalog_legacy_claim_turn bigint not null default 0;
alter table public.intelligence_directed_research_jobs
  add column catalog_requested_version text,
  add column catalog_checkpoint jsonb;

create table public.intelligence_catalog_accounts (
  company_id uuid primary key references public.companies(id),
  catalog_version text not null,
  evidence_key text,
  status text not null default 'pending' check(status in ('pending','running','complete','blocked','stale')),
  answered_count integer not null default 0,
  disposition_count integer not null default 0,
  total_count integer not null default 47 check(total_count=47),
  source_count integer not null default 0,
  retained_characters bigint not null default 0,
  processed_characters bigint not null default 0,
  industry_context jsonb not null default '{}'::jsonb,
  source_gaps jsonb not null default '[]'::jsonb,
  last_error text,retry_at timestamptz,result_updated_at timestamptz not null default now()
);
create table public.intelligence_catalog_citation_sets (
 citation_set_key text primary key check(citation_set_key ~ '^[a-f0-9]{64}$'),
 company_id uuid not null references public.companies(id),evidence_key text not null,
 citations jsonb not null check(jsonb_typeof(citations)='array'),created_at timestamptz not null default now()
);
create table public.intelligence_catalog_facets (
  company_id uuid not null references public.companies(id),
  facet_id text not null check(facet_id ~ '^rr_[a-z][0-9]{2}$' and facet_id<>'rr_o06'),
  catalog_version text not null,facet_version text not null,evidence_key text not null,
  status text not null check(status in ('pending','running','answered','blocked','stale')),
  decision text check(decision in ('supported','not_supported','insufficient_evidence','conflicting')),
  probability double precision check(probability between 0 and 1),
  native_result jsonb,
  citation_set_key text references public.intelligence_catalog_citation_sets(citation_set_key),
  citations jsonb not null default '[]'::jsonb,
  request_fingerprints jsonb not null default '[]'::jsonb,
  last_error text,updated_at timestamptz not null default now(),
  primary key(company_id,facet_id),
  check((status='answered') is not true or (native_result is not null and decision is not null))
);
create index intelligence_catalog_facets_search on public.intelligence_catalog_facets(catalog_version,facet_id,decision,company_id) where status='answered';
alter table public.intelligence_catalog_accounts enable row level security;
alter table public.intelligence_catalog_facets enable row level security;
alter table public.intelligence_catalog_citation_sets enable row level security;
revoke all on public.intelligence_catalog_accounts,public.intelligence_catalog_facets,public.intelligence_catalog_citation_sets from public,anon,authenticated;
grant all on public.intelligence_catalog_accounts,public.intelligence_catalog_facets,public.intelligence_catalog_citation_sets to service_role;

-- A stable inventory, not a duplicate source corpus. Capture/poll clocks do not
-- change the key. Source dates, identities, exclusions and retained content do.
create function public.intelligence_catalog_evidence(p_company uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 with context as (
 select jsonb_build_object('id',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,
   'industry',c.ns_industry,'city',c.city,'state',c.state,'internalId',c.netsuite_internal_id) as company
 from companies c where c.id=p_company and c.lists @> array['netsuite_tam']::text[]
   and c.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
   and c.netsuite_internal_id ~ '^[0-9]+$'
 ), evidence as (
 select coalesce(jsonb_agg(jsonb_build_object('id',o.id,'contentHash',o.content_hash,'url',o.source_url,
   'title',o.title,'sourceKind',o.source_kind,'eventDate',o.event_date,
   'characters',length(o.evidence_text),
   'sourceTruncated',coalesce(o.metadata->'textTruncated'='true'::jsonb,false) or coalesce(o.metadata->'sourceTruncated'='true'::jsonb,false)) order by o.id),'[]'::jsonb) as sources
 from intelligence_observations o where o.company_id=p_company and o.is_current and not o.feedback_excluded
 ), payload as (select jsonb_build_object('company',company,'sources',sources) as value from context cross join evidence)
 select value||jsonb_build_object('evidenceKey',encode(sha256(convert_to(value::text,'UTF8')),'hex')) from payload;
$$;

create function public.intelligence_catalog_admit(p_company uuid,p_version text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype;
begin
 select * into cfg from intelligence_config where id=1;
 if cfg.catalog_mode='off' or (cfg.catalog_mode='pilot' and cfg.catalog_pilot_company_id is distinct from p_company) then return false; end if;
 if p_version is null or length(p_version) not between 1 and 120 then raise exception 'invalid_catalog_version'; end if;
 if intelligence_catalog_evidence(p_company) is null then return false; end if;
 perform intelligence_directed_refresh(p_company);
 update intelligence_directed_research_jobs set catalog_requested_version=p_version,
   status=case when status='running' and lease_until>now() then status else 'queued' end,
   due_at=now(),last_error=null,finished_at=null
 where company_id=p_company and (catalog_requested_version is distinct from p_version
   or status in ('failed','superseded') or last_error is not null);
 insert into intelligence_catalog_accounts(company_id,catalog_version) values(p_company,p_version)
 on conflict(company_id) do update set catalog_version=excluded.catalog_version,status='stale',result_updated_at=now()
 where intelligence_catalog_accounts.catalog_version<>excluded.catalog_version;
 return true;
end $$;

-- Explicit bounded admission over canonical membership. Installing the
-- migration calls neither this function nor the single-account admit function.
create function public.intelligence_catalog_admit_batch(p_version text,p_after uuid default null,p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare row record; admitted integer:=0; last_id uuid;
begin
 if not exists(select 1 from intelligence_config where id=1 and catalog_mode='rollout') then return jsonb_build_object('admitted',0,'disabled',true); end if;
 if p_limit is null or p_limit not between 1 and 100 then raise exception 'invalid_catalog_batch'; end if;
 for row in select id from companies where lists @> array['netsuite_tam']::text[]
   and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
   and netsuite_internal_id ~ '^[0-9]+$' and (p_after is null or id>p_after) order by id limit p_limit loop
   if intelligence_catalog_admit(row.id,p_version) then admitted:=admitted+1; end if; last_id:=row.id;
 end loop;
 return jsonb_build_object('admitted',admitted,'after',last_id,'exhausted',last_id is null);
end $$;

create function public.intelligence_catalog_snapshot(p_company uuid,p_lease uuid,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare payload jsonb; checkpoint jsonb;
begin
 if not exists(select 1 from intelligence_config where id=1 and enabled and catalog_mode<>'off'
   and (catalog_mode='rollout' or catalog_pilot_company_id=p_company)) then return null; end if;
 select catalog_checkpoint into checkpoint from intelligence_directed_research_jobs where company_id=p_company
   and status='running' and lease_token=p_lease and lease_until>now() and catalog_requested_version=p_version;
 if not found then return null; end if;
 payload:=intelligence_catalog_evidence(p_company);
 if payload is null then return null; end if;
 return payload||jsonb_build_object('checkpoint',case when checkpoint->>'evidenceKey'=payload->>'evidenceKey'
   and checkpoint->>'catalogVersion'=p_version then checkpoint end,
   'previousResearch',case when checkpoint->>'catalogVersion'=p_version then checkpoint->'research' end);
end $$;

-- Every checkpoint and facet publication is one transaction under the existing
-- lease and exact current evidence key. A racing source edit never publishes a
-- stale answer; paid responses remain in the durable exact-request cache.
create function public.intelligence_catalog_checkpoint(p_company uuid,p_lease uuid,p_version text,p_evidence_key text,
 p_checkpoint jsonb,p_facets jsonb default '[]'::jsonb,p_summary jsonb default '{}'::jsonb,
 p_terminal boolean default false,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job intelligence_directed_research_jobs%rowtype; current_evidence jsonb; item jsonb; final_status text; citation_key text;
begin
 select * into job from intelligence_directed_research_jobs where company_id=p_company for update;
 if not found or job.status<>'running' or job.lease_token is distinct from p_lease or job.lease_until<=now()
   or job.catalog_requested_version is distinct from p_version then return false; end if;
 current_evidence:=intelligence_catalog_evidence(p_company);
 if current_evidence is null or current_evidence->>'evidenceKey' is distinct from p_evidence_key then
   update intelligence_directed_research_jobs set status='queued',due_at=now(),catalog_checkpoint=null,lease_token=null,lease_until=null,
     last_error='catalog_evidence_changed' where company_id=p_company;
   update intelligence_catalog_accounts set status='stale',result_updated_at=now() where company_id=p_company;
   update intelligence_catalog_facets set status='stale' where company_id=p_company;
   return false;
 end if;
 if jsonb_typeof(p_facets)<>'array' or jsonb_array_length(p_facets)>47 then raise exception 'invalid_catalog_facets'; end if;
 for item in select value from jsonb_array_elements(p_facets) loop
   citation_key:=null;
   if jsonb_typeof(item->'citations')='array' and jsonb_array_length(item->'citations')>0 then
     citation_key:=encode(sha256(convert_to(jsonb_build_array(p_company,p_evidence_key,item->'citations')::text,'UTF8')),'hex');
     insert into intelligence_catalog_citation_sets(citation_set_key,company_id,evidence_key,citations)
       values(citation_key,p_company,p_evidence_key,item->'citations') on conflict do nothing;
   end if;
   insert into intelligence_catalog_facets(company_id,facet_id,catalog_version,facet_version,evidence_key,status,decision,
     probability,native_result,citation_set_key,citations,request_fingerprints,last_error)
   values(p_company,item->>'facetId',p_version,item->>'facetVersion',p_evidence_key,item->>'status',item->>'decision',
     (item->>'probability')::double precision,nullif(item->'nativeResult','null'::jsonb),citation_key,'[]'::jsonb,
     coalesce(item->'requestFingerprints','[]'::jsonb),item->>'lastError')
   on conflict(company_id,facet_id) do update set catalog_version=excluded.catalog_version,facet_version=excluded.facet_version,
     evidence_key=excluded.evidence_key,status=excluded.status,decision=excluded.decision,probability=excluded.probability,
     native_result=excluded.native_result,citation_set_key=excluded.citation_set_key,citations=excluded.citations,request_fingerprints=excluded.request_fingerprints,
     last_error=excluded.last_error,updated_at=now();
 end loop;
 final_status:=coalesce(p_summary->>'status','running');
 insert into intelligence_catalog_accounts(company_id,catalog_version,evidence_key,status,source_count,retained_characters,
   processed_characters,industry_context,source_gaps,last_error,retry_at)
 values(p_company,p_version,p_evidence_key,final_status,jsonb_array_length(current_evidence->'sources'),
   coalesce((p_summary->>'retainedCharacters')::bigint,0),coalesce((p_summary->>'processedCharacters')::bigint,0),
   coalesce(p_summary->'industryContext','{}'::jsonb),coalesce(p_summary->'sourceGaps','[]'::jsonb),p_summary->>'lastError',p_retry_at)
 on conflict(company_id) do update set catalog_version=excluded.catalog_version,evidence_key=excluded.evidence_key,
   status=excluded.status,source_count=excluded.source_count,retained_characters=excluded.retained_characters,
   processed_characters=excluded.processed_characters,industry_context=excluded.industry_context,source_gaps=excluded.source_gaps,
   last_error=excluded.last_error,retry_at=excluded.retry_at,result_updated_at=now();
 update intelligence_catalog_accounts set
   answered_count=(select count(*) from intelligence_catalog_facets where company_id=p_company and catalog_version=p_version and evidence_key=p_evidence_key and status='answered'),
   disposition_count=(select count(*) from intelligence_catalog_facets where company_id=p_company and catalog_version=p_version and evidence_key=p_evidence_key and status='answered')
 where company_id=p_company;
 if final_status='complete' and not exists(select 1 from intelligence_catalog_accounts where company_id=p_company and answered_count=47) then
   raise exception 'catalog_completion_requires_47_native_answers';
 end if;
 update intelligence_directed_research_jobs set catalog_checkpoint=p_checkpoint,
   status=case when not p_terminal then status when final_status='complete' then 'complete' else 'queued' end,
   due_at=case when p_terminal then coalesce(p_retry_at,'infinity'::timestamptz) else due_at end,
   lease_token=case when p_terminal then null else lease_token end,lease_until=case when p_terminal then null else lease_until end,
   last_error=p_summary->>'lastError',finished_at=case when p_terminal then now() else finished_at end,
   result=case when p_terminal then jsonb_build_object('outcome','catalog_'||final_status,'catalogVersion',p_version,'evidenceKey',p_evidence_key) else result end
 where company_id=p_company;
 return true;
end $$;

create or replace function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare lane bigint; available_slots integer; batch_limit integer; cfg intelligence_config%rowtype;
begin
 if p_limit is null or p_limit<1 then raise exception 'directed claim limit must be positive'; end if;
 select * into cfg from intelligence_config where id=1 for update;
 if not coalesce(cfg.enabled,false) then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
 select greatest(0,2-count(*)::integer) into available_slots from intelligence_directed_research_jobs where status='running' and lease_until>now();
 if available_slots=0 then return; end if;
 batch_limit:=least(p_limit,2,available_slots);
 update intelligence_config set directed_claim_turn=(directed_claim_turn+1)%3 where id=1 returning directed_claim_turn into lane;
 return query with picked as (
 select j.company_id from intelligence_directed_research_jobs j join companies c on c.id=j.company_id
 where c.status is distinct from 'removed_from_tam' and c.lists @> array['netsuite_tam']::text[]
   and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
   and ((cfg.catalog_mode='off' and j.catalog_requested_version is null)
     or (cfg.catalog_mode='rollout' and j.catalog_requested_version is not null)
     or (cfg.catalog_mode='pilot' and j.company_id=cfg.catalog_pilot_company_id and j.catalog_requested_version is not null))
   and j.due_at<=now() and (j.status in ('queued','complete') or (j.status='running' and j.lease_until<now()))
 order by case when lane=1 and not exists(select 1 from intelligence_observations o where o.company_id=j.company_id
   and o.is_current and not o.feedback_excluded and o.attributes is not null) then 0 else 1 end,
   j.due_at,j.requested_at,j.company_id limit batch_limit for update of j skip locked
 ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
   lease_until=now()+interval '3 minutes',attempts=j.attempts+1,
   wake_reason=case when j.status='complete' then 'scheduled_discovery' else j.wake_reason end
 from picked where j.company_id=picked.company_id returning j.*;
end $$;

-- Nonsemantic operational failure: retain the exact pending request/checkpoint
-- and wait for explicit recovery when there is no known retry instant.
create function public.intelligence_catalog_defer(p_company uuid,p_lease uuid,p_reason text,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update intelligence_directed_research_jobs set status='queued',due_at=coalesce(p_retry_at,'infinity'::timestamptz),
   lease_token=null,lease_until=null,last_error=left(p_reason,200),finished_at=now()
 where company_id=p_company and status='running' and lease_token=p_lease and lease_until>now() and catalog_requested_version is not null;
 if not found then return false; end if;
 update intelligence_catalog_accounts set status='blocked',last_error=left(p_reason,200),retry_at=p_retry_at,result_updated_at=now() where company_id=p_company;
 return true;
end $$;

create function public.intelligence_job_budget_defer(p_id uuid,p_lease uuid,p_result jsonb,p_reason text,p_retry_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update intelligence_jobs set status='queued',result=p_result,last_error='budget:'||left(p_reason,190),
   due_at=case when p_retry_at is null then 'infinity'::timestamptz else greatest(now()+interval '30 seconds',p_retry_at) end,
   attempts=greatest(attempts-1,0),lease_token=null,lease_until=null,finished_at=null
 where id=p_id and status='running' and lease_token=p_lease and lease_until>now();
 return found;
end $$;
create function public.intelligence_account_question_budget_defer(p_view uuid,p_company uuid,p_lease uuid,p_reason text,p_retry_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update intelligence_account_question_jobs set status='queued',last_error='budget:'||left(p_reason,190),
   due_at=case when p_retry_at is null then 'infinity'::timestamptz else greatest(now()+interval '30 seconds',p_retry_at) end,
   lease_token=null,lease_until=null,updated_at=now()
 where view_id=p_view and company_id=p_company and status='running' and lease_token=p_lease and lease_until>now();
 return found;
end $$;

-- Finish exactly one bounded pass through the EXISTING discovery/query/source
-- leases. Carry its cadence across a changed snapshot so a three-page capture
-- does not recursively start a fresh discovery sweep after every interpretation.
create function public.intelligence_catalog_research_finish(p_company uuid,p_lease uuid,p_outcome text,p_next_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job intelligence_directed_research_jobs%rowtype; current_key text; changed boolean; next_at timestamptz; complete boolean;
begin
 select * into job from intelligence_directed_research_jobs where company_id=p_company for update;
 if not found or job.status<>'running' or job.lease_token is distinct from p_lease or job.lease_until<=now()
   or job.catalog_requested_version is null then return false; end if;
 next_at:=greatest(now()+interval '10 minutes',coalesce(p_next_at,now()+interval '7 days'));
 current_key:=intelligence_catalog_evidence(p_company)->>'evidenceKey';
 changed:=current_key is distinct from job.catalog_checkpoint->>'evidenceKey';
 select coalesce(answered_count=47,false) into complete from intelligence_catalog_accounts where company_id=p_company;
 update intelligence_directed_research_jobs set
   catalog_checkpoint=jsonb_set(coalesce(catalog_checkpoint,'{}'::jsonb),'{research}',jsonb_build_object('doneAt',now(),'nextAt',next_at,'outcome',p_outcome)),
   status=case when changed or not coalesce(complete,false) then 'queued' else 'complete' end,
   due_at=case when changed then now() else next_at end,lease_token=null,lease_until=null,finished_at=now(),last_error=null,
   result=jsonb_build_object('outcome','catalog_research_completed','evidenceChanged',changed,'nextResearchAt',next_at)
 where company_id=p_company;
 update intelligence_catalog_accounts set status=case when changed then 'stale' when complete then 'complete' else 'blocked' end,
   retry_at=case when changed then now() else next_at end,result_updated_at=now() where company_id=p_company;
 return true;
end $$;

-- Initial catalog funding must not churn historical claims. In maintenance,
-- fresh work wins nine turns in ten; one reserved legacy slot advances retained
-- obligations without permitting the old backlog to consume the entire lane.
alter function public.intelligence_claim(integer) rename to intelligence_claim_pre_catalog;
create function public.intelligence_claim(p_limit integer default 8)
returns setof public.intelligence_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype; policy jsonb; slots integer; batch integer; legacy boolean;
begin
 if p_limit is null or p_limit<1 then raise exception 'intelligence claim limit must be positive'; end if;
 select * into cfg from intelligence_config where id=1 for update;
 if not coalesce(cfg.enabled,false) then return; end if;
 if cfg.catalog_mode='off' then return query select * from intelligence_claim_pre_catalog(p_limit); return; end if;
 policy:=intelligence_jev_budget_status();
 if cfg.catalog_mode='pilot' or policy->>'phase'<>'maintenance' or not coalesce((policy->>'enabled')::boolean,false) then return; end if;
 perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
 select greatest(0,12-count(*)::integer) into slots from intelligence_jobs where status='running' and lease_until>now();
 if slots=0 then return; end if; batch:=least(p_limit,6,slots);
 update intelligence_config set catalog_legacy_claim_turn=catalog_legacy_claim_turn+1 where id=1
   returning catalog_legacy_claim_turn%10=0 into legacy;
 return query with candidates as materialized (
 select j.id,j.created_at,j.priority,j.due_at from intelligence_jobs j
 join intelligence_observations o on o.id=j.observation_id join companies c on c.id=o.company_id
 where j.attempts<5 and j.due_at<=now() and (j.status='queued' or (j.status='running' and j.lease_until<now()))
   and o.is_current and not o.feedback_excluded and c.lists @> array['netsuite_tam']::text[]
   and c.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
   and c.netsuite_internal_id ~ '^[0-9]+$'
 ), old_slot as materialized (
 select j.id from intelligence_jobs j join candidates c on c.id=j.id
 where legacy and c.created_at<cfg.catalog_legacy_cutoff_at order by c.due_at,c.created_at,j.id limit 1 for update of j skip locked
 ), fresh as materialized (
 select j.id from intelligence_jobs j join candidates c on c.id=j.id
 where c.created_at>=cfg.catalog_legacy_cutoff_at order by c.priority desc,c.due_at,c.created_at,j.id
 limit greatest(0,batch-(select count(*)::integer from old_slot)) for update of j skip locked
 ), ready as (select id from old_slot union all select id from fresh)
 update intelligence_jobs j set status='running',attempts=j.attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes'
 from ready where j.id=ready.id returning j.*;
end $$;

alter function public.intelligence_account_question_claim() rename to intelligence_account_question_claim_pre_catalog;
create function public.intelligence_account_question_claim()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype; policy jsonb; legacy boolean; j intelligence_account_question_jobs%rowtype;
begin
 select * into cfg from intelligence_config where id=1 for update;
 if not coalesce(cfg.enabled,false) then return null; end if;
 if cfg.catalog_mode='off' then return intelligence_account_question_claim_pre_catalog(); end if;
 policy:=intelligence_jev_budget_status();
 if cfg.catalog_mode='pilot' or policy->>'phase'<>'maintenance' or not coalesce((policy->>'enabled')::boolean,false) then return null; end if;
 update intelligence_config set catalog_legacy_claim_turn=catalog_legacy_claim_turn+1 where id=1
   returning catalog_legacy_claim_turn%10=0 into legacy;
 select q.* into j from intelligence_account_question_jobs q join intelligence_views v on v.id=q.view_id
 join companies c on c.id=q.company_id where v.active and q.due_at<=now()
   and (q.status='queued' or (q.status='running' and q.lease_until<now()))
   and (q.updated_at>=cfg.catalog_legacy_cutoff_at or legacy)
   and c.lists @> array['netsuite_tam']::text[] and c.status is distinct from 'removed_from_tam'
   and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
 order by case when legacy and q.updated_at<cfg.catalog_legacy_cutoff_at then 0 else 1 end,q.due_at,q.updated_at
 limit 1 for update of q skip locked;
 if not found then return null; end if;
 update intelligence_account_question_jobs set status='running',lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',
   running_revision=case when checkpoint is null then revision else running_revision end
 where view_id=j.view_id and company_id=j.company_id returning * into j;
 return to_jsonb(j)||jsonb_build_object('question',(select question from intelligence_views where id=j.view_id),
   'company',(select name from companies where id=j.company_id),'source_ids',case when j.checkpoint is null then
     (select coalesce(jsonb_agg(id order by id),'[]') from intelligence_observations where company_id=j.company_id and is_current and not feedback_excluded) end);
end $$;
revoke all on function public.intelligence_claim(integer),public.intelligence_account_question_claim() from public,anon,authenticated;
grant execute on function public.intelligence_claim(integer),public.intelligence_account_question_claim() to service_role;

-- An actual evidence/context edit invalidates public coverage, not TAM grades.
-- It coalesces into the existing account row and never steals a live lease.
create function public.intelligence_catalog_invalidate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare company uuid;
begin
 if tg_table_name='companies' then company:=new.id; else company:=new.company_id; end if;
 if not exists(select 1 from intelligence_directed_research_jobs where company_id=company and catalog_requested_version is not null) then return new; end if;
 if tg_op='UPDATE' then
   if tg_table_name='companies' then
     if row(new.name,new.domain,new.subindustry,new.ns_industry,new.city,new.state,new.status,new.lists,new.netsuite_internal_id)
       is not distinct from row(old.name,old.domain,old.subindustry,old.ns_industry,old.city,old.state,old.status,old.lists,old.netsuite_internal_id) then return new; end if;
   elsif row(new.content_hash,new.source_url,new.title,new.event_date,new.is_current,new.feedback_excluded,new.metadata->'textTruncated',new.metadata->'sourceTruncated')
     is not distinct from row(old.content_hash,old.source_url,old.title,old.event_date,old.is_current,old.feedback_excluded,old.metadata->'textTruncated',old.metadata->'sourceTruncated') then return new; end if;
 end if;
 if exists(select 1 from intelligence_catalog_accounts a where a.company_id=company
   and a.evidence_key=intelligence_catalog_evidence(company)->>'evidenceKey') then return new; end if;
 update intelligence_catalog_accounts set status='stale',result_updated_at=now() where company_id=company;
 update intelligence_catalog_facets set status='stale' where company_id=company;
 update intelligence_directed_research_jobs set status=case when status='running' and lease_until>now() then status else 'queued' end,
   due_at=now(),wake_reason='catalog_evidence_changed',finished_at=null,last_error=null where company_id=company;
 return new;
end $$;
create trigger intelligence_catalog_source_changed after insert or update of content_hash,source_url,title,event_date,is_current,feedback_excluded,metadata
 on public.intelligence_observations for each row execute function public.intelligence_catalog_invalidate();
create trigger intelligence_catalog_company_changed after update of name,domain,subindustry,ns_industry,city,state,status,lists,netsuite_internal_id
 on public.companies for each row execute function public.intelligence_catalog_invalidate();

do $$ declare fn record; begin
 for fn in select oid::regprocedure as signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('intelligence_catalog_evidence','intelligence_catalog_admit','intelligence_catalog_admit_batch','intelligence_catalog_snapshot','intelligence_catalog_checkpoint','intelligence_catalog_defer','intelligence_catalog_research_finish','intelligence_catalog_invalidate','intelligence_job_budget_defer','intelligence_account_question_budget_defer') loop
 execute format('revoke all on function %s from public,anon,authenticated',fn.signature);
 execute format('grant execute on function %s to service_role',fn.signature);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
