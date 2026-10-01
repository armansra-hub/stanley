-- Finite accepted business scope is separate from raw whole-site discovery.
-- No provider, paid-policy, registry membership or TAM mutation is introduced.
begin;
do $$ declare c record; begin
 for c in select conname from pg_constraint where conrelid='public.intelligence_customer_research_profiles'::regclass
  and contype='c' and pg_get_constraintdef(oid) like '%customer-research-proof-v1%'
 loop execute format('alter table public.intelligence_customer_research_profiles drop constraint %I',c.conname); end loop;
end $$;
alter table public.intelligence_customer_research_profiles add constraint customer_research_proof_schema
 check(coalesce(profile->>'schema' in ('customer-research-proof-v1','customer-research-proof-v2'),false));

create or replace function public.intelligence_customer_research_scope_put(
 p_profile jsonb,p_expected_proof_hash text default null,p_registry_updated_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path=public,pg_temp set jit=off as $$
declare target_id text; registry intelligence_customer_reference_registry%rowtype;
 previous intelligence_customer_research_profiles%rowtype; new_hash text; proof_hash text; previous_hash text;
begin
 target_id=p_profile->>'customerId';new_hash=p_profile->>'fullProfileSha256';proof_hash=p_profile->>'proofSha256';
 if target_id is null or target_id !~ '^[a-zA-Z0-9_.-]{1,160}$'
  or not coalesce(p_profile->>'schema'='customer-research-proof-v2',false)
  or not coalesce(p_profile->>'sourceStorage'='private_local_full_text',false)
  or not coalesce(p_profile->'author'->>'kind'='codex',false)
  or not coalesce(new_hash ~ '^[a-f0-9]{64}$',false) or not coalesce(proof_hash ~ '^[a-f0-9]{64}$',false)
  or not coalesce(p_profile->>'status' in ('draft','in_progress','complete','complete_with_gaps','unresolved'),false)
  or not coalesce(p_profile->'businessScope'->>'status' in ('scope_complete','scope_complete_with_gaps','identity_or_source_gap'),false)
  or not coalesce(p_profile->'businessScope'->>'profileSha256'=new_hash,false)
  or not coalesce(p_profile->'businessScope'->>'wholeSiteStatus'=p_profile->>'status',false)
  or not coalesce(p_profile->'businessScope'->'receipt'->>'sha256' ~ '^[a-f0-9]{64}$',false)
  or nullif(p_profile->'businessScope'->>'acceptedScope','') is null
  or nullif(p_profile->'businessScope'->>'closedAt','') is null
  or not coalesce(p_profile->'validation'->>'kind'='local_full_text_hash_and_utf16_validation',false)
  or not coalesce(p_profile->'mapping'->>'customerId'=target_id,false)
  or not coalesce(p_profile->'mapping'->>'profileSha256'=new_hash,false)
  or not coalesce((case p_profile->'mapping'->>'scopeStatus'
    when 'business_scope_review_closed' then 'scope_complete'
    when 'business_scope_review_closed_with_source_gaps' then 'scope_complete_with_gaps'
    when 'identity_unresolved' then 'identity_or_source_gap'
    when 'identity_or_source_unresolved' then 'identity_or_source_gap'
    else p_profile->'mapping'->>'scopeStatus' end)=p_profile->'businessScope'->>'status',false)
  or jsonb_typeof(p_profile->'mapping'->'matches') is distinct from 'array'
  or jsonb_typeof(p_profile->'sources') is distinct from 'array'
  or jsonb_typeof(p_profile->'facts') is distinct from 'array'
  or jsonb_typeof(p_profile->'criterionBindings') is distinct from 'array'
  or jsonb_typeof(p_profile->'announcementIds') is distinct from 'array'
  then raise exception 'Invalid compact business scope proof'; end if;
 if exists(select 1 from jsonb_array_elements(p_profile->'sources') s where s ? 'text')
  or exists(select 1 from jsonb_array_elements(p_profile->'facts') f where f ? 'nativeResult'
    or not coalesce(f->>'origin'='codex_research',false))
  or p_profile ? 'nativeResult' or p_profile ? 'tamScore'
  then raise exception 'Only compact authored proof is allowed'; end if;
 if exists(select 1 from jsonb_array_elements(p_profile->'criterionBindings') b where
  not coalesce(b->>'customerId'=target_id,false) or not coalesce(b->>'profileSha256'=new_hash,false)
  or not coalesce(b->>'state' in ('supported','not_supported','unknown','conflicting'),false)
  or jsonb_typeof(b->'factIds') is distinct from 'array'
  or (b->>'state'='supported' and (p_profile->'businessScope'->>'status'='identity_or_source_gap'
    or jsonb_array_length(p_profile->'mapping'->'matches')=0 or jsonb_array_length(b->'factIds')=0
    or exists(select 1 from jsonb_array_elements_text(b->'factIds') fid where not exists(
      select 1 from jsonb_array_elements(p_profile->'facts') f where f->>'id'=fid
      and f->>'state'='supported' and f->'subject'->>'kind'='customer')))))
  then raise exception 'Invalid predicate binding'; end if;
 perform pg_advisory_xact_lock(hashtextextended(target_id,7935));
 select * into registry from intelligence_customer_reference_registry where id=target_id and active for update;
 if not found then raise exception 'Customer registry identity changed'; end if;
 if p_registry_updated_at is null or registry.updated_at<>p_registry_updated_at or registry.name<>p_profile->>'name'
  or (select coalesce(jsonb_agg(value order by value),'[]') from jsonb_array_elements(p_profile->'announcementIds'))
   is distinct from (select coalesce(jsonb_agg(a->'id' order by a->'id'),'[]') from jsonb_array_elements(registry.announcements) a)
  then raise exception 'Customer registry identity changed'; end if;
 select * into previous from intelligence_customer_research_profiles where customer_id=target_id for update;
 if found then
  previous_hash=coalesce(previous.profile->>'proofSha256',previous.full_profile_sha256);
  if previous_hash=proof_hash then
   if previous.profile is distinct from p_profile then raise exception 'Customer proof hash conflict';end if;
   return jsonb_build_object('customerId',target_id,'proofSha256',proof_hash,'unchanged',true);
  end if;
  if p_expected_proof_hash is null or previous_hash<>p_expected_proof_hash then raise exception 'Customer research write conflict';end if;
  update intelligence_customer_research_profiles set full_profile_sha256=new_hash,research_status=p_profile->>'status',profile=p_profile,updated_at=now() where customer_id=target_id;
 else
  if p_expected_proof_hash is not null then raise exception 'Customer research write conflict';end if;
  insert into intelligence_customer_research_profiles(customer_id,full_profile_sha256,research_status,profile)
   values(target_id,new_hash,p_profile->>'status',p_profile);
 end if;
 return jsonb_build_object('customerId',target_id,'proofSha256',proof_hash,'unchanged',false);
end $$;

create or replace function public.intelligence_customer_research_progress()
returns jsonb language sql stable security definer set search_path=public,pg_temp set jit=off as $$
 select jsonb_build_object('total',count(*),'started',count(*) filter(where p.research_status in ('in_progress','complete','complete_with_gaps','unresolved')),
  'notStarted',count(*) filter(where p.customer_id is null),'draft',count(*) filter(where p.research_status='draft'),
  'inProgress',count(*) filter(where p.research_status='in_progress'),'complete',count(*) filter(where p.research_status='complete'),
  'completeWithGaps',count(*) filter(where p.research_status='complete_with_gaps'),'unresolved',count(*) filter(where p.research_status='unresolved'),
  'businessScopeComplete',count(*) filter(where p.profile->'businessScope'->>'status'='scope_complete'),
  'businessScopeCompleteWithGaps',count(*) filter(where p.profile->'businessScope'->>'status'='scope_complete_with_gaps'),
  'businessScopeIdentityOrSourceGap',count(*) filter(where p.profile->'businessScope'->>'status'='identity_or_source_gap'),
  'mappedReferences',count(*) filter(where jsonb_array_length(coalesce(p.profile->'mapping'->'matches','[]'))>0),
  'referencesWithCriterionBindings',count(*) filter(where jsonb_array_length(coalesce(p.profile->'criterionBindings','[]'))>0),
  'facts',coalesce(sum(jsonb_array_length(p.profile->'facts')),0),'readPages',coalesce(sum((p.profile->'coverage'->>'read')::integer),0),
  'pendingPages',coalesce(sum((p.profile->'coverage'->>'pending')::integer),0),'unreadPages',coalesce(sum((p.profile->'coverage'->>'unread')::integer),0),
  'unavailablePages',coalesce(sum((p.profile->'coverage'->>'unavailable')::integer),0),
  'latestUpdatedAt',max(p.updated_at),'origin','codex_research','providerCalls',0)
 from intelligence_customer_reference_registry r left join intelligence_customer_research_profiles p on p.customer_id=r.id where r.active;
$$;
revoke all on function public.intelligence_customer_research_scope_put(jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.intelligence_customer_research_scope_put(jsonb,text,timestamptz) to service_role;
notify pgrst,'reload schema';
commit;
