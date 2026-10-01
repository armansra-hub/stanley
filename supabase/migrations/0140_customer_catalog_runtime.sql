-- Immutable customer dictionaries on the existing company lease and paid lane.
-- Installation/registration/selection never enables paid policy or queues work.
begin;
create table public.intelligence_catalog_dictionaries (
 version text primary key check(length(version) between 1 and 120),
 status text not null check(status='approved'), dictionary jsonb not null,
 created_at timestamptz not null default now(),
 check(dictionary->>'version'=version and dictionary->>'status'=status)
);
create table public.intelligence_catalog_dictionary_facets (
 catalog_version text not null references public.intelligence_catalog_dictionaries(version),
 facet_id text not null check(facet_id ~ '^[a-zA-Z0-9_.-]{1,160}$'),
 facet_version text not null check(facet_version ~ '^[a-f0-9]{64}$'),
 kind text not null default 'criterion' check(kind in ('criterion','industry_context')),
 wire_id text not null check(wire_id ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'),
 primary key(catalog_version,facet_id), unique(catalog_version,wire_id)
);
create table public.intelligence_catalog_legacy_versions(version text primary key);
insert into public.intelligence_catalog_legacy_versions values('ring-ring-v1-c0012781b571b5603446fc35c9d3dacaca9079d4732fad2335ed4b97e67441e3');
insert into public.intelligence_catalog_legacy_versions
 select distinct catalog_version from public.intelligence_catalog_accounts on conflict do nothing;
insert into public.intelligence_catalog_legacy_versions
 select distinct catalog_requested_version from public.intelligence_directed_research_jobs where catalog_requested_version is not null on conflict do nothing;
alter table public.intelligence_config add column selected_catalog_version text references public.intelligence_catalog_dictionaries(version);
alter table public.intelligence_catalog_accounts add column context_total_count integer not null default 0, add column context_answered_count integer not null default 0;
alter table public.intelligence_catalog_accounts drop constraint intelligence_catalog_accounts_total_count_check;
alter table public.intelligence_catalog_accounts add constraint intelligence_catalog_accounts_total_positive check(total_count>0);
alter table public.intelligence_catalog_facets drop constraint intelligence_catalog_facets_facet_id_check;
alter table public.intelligence_catalog_facets add constraint intelligence_catalog_facet_id_shape check(facet_id ~ '^[a-zA-Z0-9_.-]{1,160}$');

create function public.intelligence_catalog_cohort_current(p_dictionary jsonb)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(jsonb_typeof(p_dictionary->'cohortProof'->'customers')='array'
  and (p_dictionary->'cohortProof'->>'cohortCount')::integer=(select count(*) from intelligence_customer_reference_registry where active)
  and jsonb_array_length(p_dictionary->'cohortProof'->'customers')=(p_dictionary->'cohortProof'->>'cohortCount')::integer
  and jsonb_array_length(p_dictionary->'cohortProof'->'customers')=(select count(distinct c->>'customerId') from jsonb_array_elements(p_dictionary->'cohortProof'->'customers') c)
  and not exists(select 1 from jsonb_array_elements(p_dictionary->'cohortProof'->'customers') c where not exists(
   select 1 from intelligence_customer_reference_registry r join intelligence_customer_research_profiles p on p.customer_id=r.id
   where r.active and r.id=c->>'customerId' and p.full_profile_sha256=c->>'profileSha256'
    and p.profile->>'proofSha256'=c->>'proofSha256' and p.profile->>'schema'='customer-research-proof-v2'
    and p.profile->'businessScope'->>'status' in ('scope_complete','scope_complete_with_gaps','identity_or_source_gap'))),false);
$$;

create function public.intelligence_catalog_register(p_version text,p_dictionary jsonb,p_facets jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare previous jsonb; item jsonb; expected integer;
begin
 if p_version is null or length(p_version) not between 1 and 120
  or p_dictionary->>'version' is distinct from p_version or p_dictionary->>'status' is distinct from 'approved'
  or p_dictionary->>'schema' is distinct from 'customer-approved-catalog-v1'
  or jsonb_typeof(p_dictionary->'cohortProof') is distinct from 'object'
  or not coalesce((p_dictionary->'cohortProof'->>'cohortCount')::integer>0,false)
  or (p_dictionary->'cohortProof'->>'cohortCount') is distinct from (p_dictionary->'cohortProof'->>'accountedForCount')
  or jsonb_typeof(p_dictionary->'industryContextDefinitions') is distinct from 'array'
  or jsonb_typeof(p_dictionary->'facets') is distinct from 'array'
  or jsonb_typeof(p_facets) is distinct from 'array' then raise exception 'invalid_catalog_dictionary'; end if;
 if not intelligence_catalog_cohort_current(p_dictionary) then raise exception 'catalog_cohort_changed_or_unfinished'; end if;
 expected:=jsonb_array_length(p_dictionary->'facets')+jsonb_array_length(p_dictionary->'industryContextDefinitions');
 if jsonb_array_length(p_dictionary->'facets')<1 or expected>1000 or jsonb_array_length(p_facets)<>expected
  or jsonb_array_length(p_dictionary->'facets')<>(select count(distinct f->>'id') from jsonb_array_elements(p_dictionary->'facets') f)
  or jsonb_array_length(p_dictionary->'industryContextDefinitions')<>(select count(distinct f->>'id') from jsonb_array_elements(p_dictionary->'industryContextDefinitions') f)
  or expected<>(select count(distinct f->>'facetId') from jsonb_array_elements(p_facets) f)
  or expected<>(select count(distinct f->>'wireId') from jsonb_array_elements(p_facets) f)
  or exists(select 1 from jsonb_array_elements(p_facets) f where not exists(
   select 1 from jsonb_array_elements(p_dictionary->'facets') d where d->>'id'=f->>'facetId' and f->>'kind'='criterion'
    and nullif(d->>'definitionVersion','') is not null) and not exists(select 1 from jsonb_array_elements(p_dictionary->'industryContextDefinitions') d
     where 'industry_context_'||(d->>'id')=f->>'facetId' and f->>'kind'='industry_context')) then raise exception 'invalid_catalog_membership'; end if;
 perform pg_advisory_xact_lock(hashtextextended('catalog-register:'||p_version,0));
 select dictionary into previous from intelligence_catalog_dictionaries where version=p_version;
 if found then
  if previous is distinct from p_dictionary or exists(select 1 from jsonb_array_elements(p_facets) f
   where not exists(select 1 from intelligence_catalog_dictionary_facets x where x.catalog_version=p_version
    and x.facet_id=f->>'facetId' and x.facet_version=f->>'facetVersion' and x.wire_id=f->>'wireId' and x.kind=f->>'kind'))
   then raise exception 'immutable_catalog_conflict'; end if;
  return jsonb_build_object('version',p_version,'unchanged',true,'facets',expected);
 end if;
 if exists(select 1 from intelligence_catalog_legacy_versions where version=p_version) then raise exception 'legacy_version_reserved'; end if;
 insert into intelligence_catalog_dictionaries(version,status,dictionary) values(p_version,'approved',p_dictionary);
 for item in select value from jsonb_array_elements(p_facets) loop
  insert into intelligence_catalog_dictionary_facets(catalog_version,facet_id,facet_version,wire_id,kind) values(p_version,item->>'facetId',item->>'facetVersion',item->>'wireId',item->>'kind');
 end loop;
 return jsonb_build_object('version',p_version,'unchanged',false,'facets',expected);
end $$;

create function public.intelligence_catalog_select(p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if p_version is not null and not exists(select 1 from intelligence_catalog_dictionaries where version=p_version and status='approved')
  then raise exception 'catalog_not_registered'; end if;
 if p_version is not null and not intelligence_catalog_cohort_current((select dictionary from intelligence_catalog_dictionaries where version=p_version))
  then raise exception 'catalog_cohort_changed_or_unfinished'; end if;
 update intelligence_config set selected_catalog_version=p_version where id=1;
 return jsonb_build_object('selectedVersion',p_version,'paidPolicyChanged',false,'jobsAdmitted',0);
end $$;
create function public.intelligence_catalog_dictionary_get(p_version text default null)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select dictionary from intelligence_catalog_dictionaries where version=coalesce(p_version,
  (select selected_catalog_version from intelligence_config where id=1)) and status='approved';
$$;

-- SQL readers and writers share the exact registered membership. The only
-- wildcard semantic versions are explicitly retained historical legacy sets.
create function public.intelligence_catalog_expected_facets(p_version text)
returns table(facet_id text,facet_version text,wire_id text,kind text)
language sql stable security definer set search_path=public,pg_temp as $$
 select f.facet_id,f.facet_version,f.wire_id,f.kind from intelligence_catalog_dictionary_facets f where f.catalog_version=p_version
 union all
 select id,null::text,id,'criterion'::text from unnest(array['rr_c01','rr_c02','rr_c03','rr_c04','rr_c05','rr_c06','rr_c07','rr_c08','rr_c09','rr_c10','rr_c11','rr_c12',
 'rr_t01','rr_t02','rr_t03','rr_t04','rr_t05','rr_f01','rr_f02','rr_f03','rr_i01','rr_i02','rr_i03','rr_i04',
 'rr_p01','rr_p02','rr_p03','rr_m01','rr_m02','rr_m03','rr_m04','rr_h01','rr_h02','rr_h03',
 'rr_s01','rr_s02','rr_s03','rr_r01','rr_r02','rr_r03','rr_n01','rr_n02','rr_o01','rr_o02','rr_o03','rr_o04','rr_o05']) id
 where exists(select 1 from intelligence_catalog_legacy_versions where version=p_version)
 and not exists(select 1 from intelligence_catalog_dictionaries where version=p_version);
$$;

-- Mirrors remain compatible with old readers. History retains the unmodified
-- native result, original receipts and citation-set key before another catalog.
create table public.intelligence_catalog_facet_history (
 company_id uuid not null,facet_id text not null,catalog_version text not null,facet_version text not null,evidence_key text not null,
 snapshot jsonb not null,archived_at timestamptz not null default now(),
 primary key(company_id,facet_id,catalog_version,facet_version,evidence_key)
);
create table public.intelligence_catalog_account_history (
 history_id bigint generated always as identity primary key,company_id uuid not null,catalog_version text not null,
 snapshot_sha256 text not null unique,snapshot jsonb not null,archived_at timestamptz not null default now()
);
insert into intelligence_catalog_facet_history(company_id,facet_id,catalog_version,facet_version,evidence_key,snapshot)
 select company_id,facet_id,catalog_version,facet_version,evidence_key,to_jsonb(f) from intelligence_catalog_facets f where native_result is not null;
insert into intelligence_catalog_account_history(company_id,catalog_version,snapshot_sha256,snapshot)
 select company_id,catalog_version,encode(sha256(convert_to(to_jsonb(a)::text,'UTF8')),'hex'),to_jsonb(a) from intelligence_catalog_accounts a;
create function public.intelligence_catalog_archive_mirror()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if tg_table_name='intelligence_catalog_facets' then
  if new.native_result is not null and new.status='answered' then
   insert into intelligence_catalog_facet_history(company_id,facet_id,catalog_version,facet_version,evidence_key,snapshot)
    values(new.company_id,new.facet_id,new.catalog_version,new.facet_version,new.evidence_key,to_jsonb(new)) on conflict do nothing;
  end if;
 else
  insert into intelligence_catalog_account_history(company_id,catalog_version,snapshot_sha256,snapshot)
   values(new.company_id,new.catalog_version,encode(sha256(convert_to(to_jsonb(new)::text,'UTF8')),'hex'),to_jsonb(new)) on conflict do nothing;
 end if;
 return new;
end $$;
create trigger intelligence_catalog_archive_facets after insert or update on intelligence_catalog_facets
 for each row execute function intelligence_catalog_archive_mirror();
create trigger intelligence_catalog_archive_accounts after insert or update on intelligence_catalog_accounts
 for each row execute function intelligence_catalog_archive_mirror();
create view public.intelligence_catalog_read_accounts as
 select a.* from intelligence_catalog_accounts a
 union all
 select (jsonb_populate_record(null::intelligence_catalog_accounts,h.snapshot)).* from (
  select distinct on(company_id,catalog_version) * from intelligence_catalog_account_history
  order by company_id,catalog_version,history_id desc
 ) h where not exists(select 1 from intelligence_catalog_accounts a where a.company_id=h.company_id and a.catalog_version=h.catalog_version);
create view public.intelligence_catalog_read_facets as
 with all_rows as (
  select f.* from intelligence_catalog_facets f
  union all select (jsonb_populate_record(null::intelligence_catalog_facets,h.snapshot)).* from intelligence_catalog_facet_history h
 ), chosen as (
  select distinct on(company_id,facet_id,catalog_version,facet_version,evidence_key) * from all_rows
  order by company_id,facet_id,catalog_version,facet_version,evidence_key,(status='answered') desc,updated_at desc
 )
 select f.company_id,f.facet_id,f.catalog_version,f.facet_version,f.evidence_key,f.status,f.decision,f.probability,
  f.native_result,f.citation_set_key,coalesce(cs.citations,f.citations) as citations,f.request_fingerprints,f.last_error,f.updated_at
 from chosen f left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
  and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key;

create function public.intelligence_catalog_complete_set(p_company uuid,p_version text,p_evidence_key text)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from intelligence_catalog_expected_facets(p_version)) and not exists(
  select 1 from intelligence_catalog_expected_facets(p_version) e where not exists(
   select 1 from intelligence_catalog_facets f where f.company_id=p_company and f.catalog_version=p_version
    and f.evidence_key=p_evidence_key and f.facet_id=e.facet_id and (e.facet_version is null or f.facet_version=e.facet_version)
    and f.status='answered' and f.decision is not null and f.native_result is not null
    and (e.facet_version is null or f.native_result->>'questionId'=e.facet_id)));
$$;


create or replace function public.intelligence_catalog_admit(p_company uuid,p_version text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare cfg intelligence_config%rowtype; expected integer; contexts integer;
begin
 select * into cfg from intelligence_config where id=1;
 if cfg.catalog_mode='off' or (cfg.catalog_mode='pilot' and cfg.catalog_pilot_company_id is distinct from p_company) then return false; end if;
 select count(*) filter(where kind='criterion'),count(*) filter(where kind='industry_context') into expected,contexts from intelligence_catalog_expected_facets(p_version);
 if expected=0 then raise exception 'catalog_not_registered'; end if;
 if exists(select 1 from intelligence_catalog_dictionaries where version=p_version) and cfg.selected_catalog_version is distinct from p_version then return false; end if;
 if exists(select 1 from intelligence_catalog_dictionaries where version=p_version) and not intelligence_catalog_cohort_current(
  (select dictionary from intelligence_catalog_dictionaries where version=p_version)) then return false; end if;
 if exists(select 1 from intelligence_directed_research_jobs where company_id=p_company and status='running' and lease_until>now()
   and catalog_requested_version is distinct from p_version) then return false; end if;
 if intelligence_catalog_evidence(p_company) is null then return false; end if;
 perform intelligence_directed_refresh(p_company);
 update intelligence_directed_research_jobs set catalog_checkpoint=case when catalog_requested_version is distinct from p_version then null else catalog_checkpoint end,catalog_requested_version=p_version,
   status=case when status='running' and lease_until>now() then status else 'queued' end,
   due_at=now(),last_error=null,finished_at=null
 where company_id=p_company and (catalog_requested_version is distinct from p_version
   or status in ('failed','superseded') or last_error is not null);
 insert into intelligence_catalog_accounts(company_id,catalog_version,total_count,context_total_count) values(p_company,p_version,expected,contexts)
 on conflict(company_id) do update set catalog_version=excluded.catalog_version,total_count=excluded.total_count,context_total_count=excluded.context_total_count,status='stale',result_updated_at=now()
 where intelligence_catalog_accounts.catalog_version<>excluded.catalog_version;
 return true;
end $$;

create or replace function public.intelligence_catalog_snapshot(p_company uuid,p_lease uuid,p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare payload jsonb; checkpoint jsonb;
begin
 if not exists(select 1 from intelligence_catalog_expected_facets(p_version)) then return null; end if;
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

create or replace function public.intelligence_catalog_checkpoint(p_company uuid,p_lease uuid,p_version text,p_evidence_key text,
 p_checkpoint jsonb,p_facets jsonb default '[]'::jsonb,p_summary jsonb default '{}'::jsonb,
 p_terminal boolean default false,p_retry_at timestamptz default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job intelligence_directed_research_jobs%rowtype; current_evidence jsonb; item jsonb; final_status text; citation_key text; expected integer; contexts integer;
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
 select count(*) filter(where kind='criterion'),count(*) filter(where kind='industry_context') into expected,contexts from intelligence_catalog_expected_facets(p_version);
 if expected=0 or jsonb_typeof(p_facets) is distinct from 'array' or jsonb_array_length(p_facets)>expected+contexts
  or jsonb_array_length(p_facets)<>(select count(distinct f->>'facetId') from jsonb_array_elements(p_facets) f)
  or p_checkpoint->>'catalogVersion' is distinct from p_version or p_checkpoint->>'evidenceKey' is distinct from p_evidence_key
  or exists(select 1 from jsonb_array_elements(p_facets) f where not exists(select 1 from intelligence_catalog_expected_facets(p_version) e
   where e.facet_id=f->>'facetId' and (e.facet_version is null or e.facet_version=f->>'facetVersion')))
  then raise exception 'invalid_catalog_facets'; end if;
 for item in select value from jsonb_array_elements(p_facets) loop
   citation_key:=null;
   if item->>'status'='answered' and exists(select 1 from intelligence_catalog_dictionaries where version=p_version)
    and (item->'nativeResult'->>'questionId' is distinct from item->>'facetId'
     or item->'nativeResult'->>'wireQuestionId' is distinct from (select wire_id from intelligence_catalog_dictionary_facets where catalog_version=p_version and facet_id=item->>'facetId')
     or item->>'decision' is distinct from case when item->'nativeResult'->'answer'->>'choice'='unknown' then 'insufficient_evidence' else item->'nativeResult'->'answer'->>'choice' end)
    then raise exception 'invalid_catalog_native_result'; end if;
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
 insert into intelligence_catalog_accounts(company_id,catalog_version,evidence_key,status,total_count,context_total_count,source_count,retained_characters,
   processed_characters,industry_context,source_gaps,last_error,retry_at)
 values(p_company,p_version,p_evidence_key,final_status,expected,contexts,jsonb_array_length(current_evidence->'sources'),
   coalesce((p_summary->>'retainedCharacters')::bigint,0),coalesce((p_summary->>'processedCharacters')::bigint,0),
   coalesce(p_summary->'industryContext','{}'::jsonb),coalesce(p_summary->'sourceGaps','[]'::jsonb),p_summary->>'lastError',p_retry_at)
 on conflict(company_id) do update set catalog_version=excluded.catalog_version,evidence_key=excluded.evidence_key,
   status=excluded.status,total_count=excluded.total_count,context_total_count=excluded.context_total_count,source_count=excluded.source_count,retained_characters=excluded.retained_characters,
   processed_characters=excluded.processed_characters,industry_context=excluded.industry_context,source_gaps=excluded.source_gaps,
   last_error=excluded.last_error,retry_at=excluded.retry_at,result_updated_at=now();
 update intelligence_catalog_accounts a set
   answered_count=(select count(*) from intelligence_catalog_facets f join intelligence_catalog_expected_facets(p_version) e on e.facet_id=f.facet_id
     and (e.facet_version is null or e.facet_version=f.facet_version) where f.company_id=p_company and f.catalog_version=p_version
     and f.evidence_key=p_evidence_key and f.status='answered' and e.kind='criterion'),
   context_answered_count=(select count(*) from intelligence_catalog_facets f join intelligence_catalog_expected_facets(p_version) e on e.facet_id=f.facet_id
     and (e.facet_version is null or e.facet_version=f.facet_version) where f.company_id=p_company and f.catalog_version=p_version
     and f.evidence_key=p_evidence_key and f.status='answered' and e.kind='industry_context'),
   disposition_count=(select count(*) from intelligence_catalog_facets where company_id=p_company and catalog_version=p_version and evidence_key=p_evidence_key and status='answered')
 where a.company_id=p_company;
 if final_status='complete' and not intelligence_catalog_complete_set(p_company,p_version,p_evidence_key) then
   raise exception 'catalog_completion_requires_exact_native_set';
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

create or replace function public.intelligence_catalog_research_finish(p_company uuid,p_lease uuid,p_outcome text,p_next_at timestamptz)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare job intelligence_directed_research_jobs%rowtype; current_key text; changed boolean; next_at timestamptz; complete boolean;
begin
 select * into job from intelligence_directed_research_jobs where company_id=p_company for update;
 if not found or job.status<>'running' or job.lease_token is distinct from p_lease or job.lease_until<=now()
   or job.catalog_requested_version is null then return false; end if;
 next_at:=greatest(now()+interval '10 minutes',coalesce(p_next_at,now()+interval '7 days'));
 current_key:=intelligence_catalog_evidence(p_company)->>'evidenceKey';
 changed:=current_key is distinct from job.catalog_checkpoint->>'evidenceKey';
 complete:=intelligence_catalog_complete_set(p_company,job.catalog_requested_version,current_key);
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

create or replace function public.intelligence_catalog_remember_completion()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.evidence_key is not null and new.answered_count=new.total_count and new.context_answered_count=new.context_total_count
  and intelligence_catalog_complete_set(new.company_id,new.catalog_version,new.evidence_key)
  then new.last_completed_catalog_version:=new.catalog_version; end if;
 return new;
end $$;

drop trigger intelligence_catalog_completed_version on intelligence_catalog_accounts;
create trigger intelligence_catalog_completed_version before insert or update of answered_count,context_answered_count,catalog_version,evidence_key,status
on intelligence_catalog_accounts for each row execute function intelligence_catalog_remember_completion();

create or replace function public.intelligence_directed_claim(p_limit integer default 1)
returns setof public.intelligence_directed_research_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare lane bigint; cfg intelligence_config%rowtype;
begin
  if p_limit is null or p_limit<1 then raise exception 'directed claim limit must be positive'; end if;
  select * into cfg from intelligence_config where id=1 for update;
  if not coalesce(cfg.enabled,false) then return; end if;
  -- Provider/manual holds remain authoritative. This is not a spend allowance;
  -- the existing dispatch ticket still makes the final paid-request decision.
  if cfg.catalog_mode<>'off' and not exists(select 1 from intelligence_jev_budget_policy
    where id='jev-rollout-2026-09-24' and enabled) then return; end if;
  perform pg_advisory_xact_lock(hashtextextended('intelligence-worker-capacity',0));
  update intelligence_config set directed_claim_turn=(directed_claim_turn+1)%3
    where id=1 returning directed_claim_turn into lane;
  return query with picked as (
    select j.company_id from intelligence_directed_research_jobs j
    join companies c on c.id=j.company_id
    left join intelligence_catalog_accounts a on a.company_id=j.company_id
    where c.status is distinct from 'removed_from_tam' and c.lists @> array['netsuite_tam']::text[]
      and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and c.netsuite_internal_id ~ '^[0-9]+$'
      and ((cfg.catalog_mode='off' and j.catalog_requested_version is null)
        or (cfg.catalog_mode='rollout' and j.catalog_requested_version is not null)
        or (cfg.catalog_mode='pilot' and j.company_id=cfg.catalog_pilot_company_id and j.catalog_requested_version is not null))
      and j.due_at<=now() and (j.status in ('queued','complete') or (j.status='running' and j.lease_until<now()))
    order by
      case when j.catalog_requested_version is not null and
        a.last_completed_catalog_version is distinct from j.catalog_requested_version then 0 else 1 end,
      -- Persisted partial first passes finish before untouched accounts. A
      -- previously completed refresh cannot regain first-pass priority simply
      -- because source invalidation made its answer count fall to zero.
      case when j.catalog_requested_version is not null and
        a.last_completed_catalog_version is distinct from j.catalog_requested_version and
        a.catalog_version=j.catalog_requested_version and (a.answered_count+a.context_answered_count)>0 and (a.answered_count<a.total_count or a.context_answered_count<a.context_total_count) then 0 else 1 end,
      case when j.catalog_requested_version is null and lane=1 and not exists(
        select 1 from intelligence_observations o where o.company_id=j.company_id
          and o.is_current and not o.feedback_excluded and o.attributes is not null) then 0 else 1 end,
      j.due_at,j.requested_at,j.company_id limit p_limit for update of j skip locked
  ) update intelligence_directed_research_jobs j set status='running',lease_token=gen_random_uuid(),
    lease_until=now()+interval '3 minutes',attempts=j.attempts+1,
    wake_reason=case when j.status='complete' then 'scheduled_discovery' else j.wake_reason end
  from picked where j.company_id=picked.company_id returning j.*;
end $$;

do $$ declare t text; begin
 foreach t in array array['intelligence_catalog_dictionaries','intelligence_catalog_dictionary_facets','intelligence_catalog_legacy_versions','intelligence_catalog_facet_history','intelligence_catalog_account_history'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated,service_role',t);
  execute format('grant select on public.%I to service_role',t);
 end loop;
end $$;
revoke all on intelligence_catalog_read_accounts,intelligence_catalog_read_facets from public,anon,authenticated;
grant select on intelligence_catalog_read_accounts,intelligence_catalog_read_facets to service_role;
revoke all on function intelligence_catalog_archive_mirror() from public,anon,authenticated,service_role;
revoke all on function intelligence_catalog_register(text,jsonb,jsonb),intelligence_catalog_select(text),
 intelligence_catalog_dictionary_get(text),intelligence_catalog_expected_facets(text),intelligence_catalog_complete_set(uuid,text,text),intelligence_catalog_cohort_current(jsonb)
 from public,anon,authenticated;
grant execute on function intelligence_catalog_register(text,jsonb,jsonb),intelligence_catalog_select(text),
 intelligence_catalog_dictionary_get(text),intelligence_catalog_expected_facets(text),intelligence_catalog_complete_set(uuid,text,text),intelligence_catalog_cohort_current(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
