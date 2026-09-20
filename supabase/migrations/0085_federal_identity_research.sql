-- Public sourced identity trails + bounded, history-preserving weak-link repair.
begin;
create table public.company_federal_identity_claims (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
 observation_id uuid not null references intelligence_observations(id), fingerprint text not null,
 subject_name text not null, candidate_name text not null, relationship text not null
   check (relationship in ('legal_name','dba','former_name','parent','subsidiary','joint_venture','division')),
 source_url text not null, source_quote text not null, captured_at timestamptz not null,
 evidence jsonb not null default '{}', recipient_cursor jsonb not null default '{}',
 status text not null default 'pending' check (status in ('pending','searching','complete','needs_evidence')),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,fingerprint)
);
create index on public.company_federal_identity_claims(company_id,status,updated_at);
create table public.federal_identity_candidate_receipts (
 id uuid primary key default gen_random_uuid(), claim_id uuid not null references company_federal_identity_claims(id),
 uei text not null, generated_award_id text not null, outcome text not null, decision jsonb not null,
 source_url text not null, observed_at timestamptz not null default now(), unique(claim_id,uei)
);
create table public.company_related_government_entities (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
 government_entity_id uuid not null references government_entities(id), claim_id uuid not null references company_federal_identity_claims(id),
 relationship text not null check (relationship in ('parent','subsidiary','joint_venture','division')),
 evidence jsonb not null, created_at timestamptz not null default now(),
 unique(company_id,government_entity_id,claim_id)
);
create table public.federal_identity_jobs (
 company_id uuid primary key references companies(id) on delete cascade, cursor jsonb not null default '{}',
 due_at timestamptz not null default now(), lease_token uuid, lease_expires_at timestamptz,
 attempts integer not null default 0, last_receipt jsonb, updated_at timestamptz not null default now()
);
create table public.federal_identity_remediation_receipts (
 id uuid primary key default gen_random_uuid(), match_id uuid not null references company_government_matches(id),
 company_id uuid not null references companies(id), policy_version text not null default 'identity-evidence-v2',
 before_image jsonb not null, after_image jsonb, outcome text not null, evidence jsonb not null,
 trigger_before_images jsonb not null default '[]', created_at timestamptz not null default now()
);
create index on public.federal_identity_remediation_receipts(match_id,created_at desc);
alter table public.company_federal_identity_claims enable row level security;
alter table public.federal_identity_candidate_receipts enable row level security;
alter table public.company_related_government_entities enable row level security;
alter table public.federal_identity_jobs enable row level security;
alter table public.federal_identity_remediation_receipts enable row level security;
revoke all on public.company_federal_identity_claims,public.company_related_government_entities,public.federal_identity_jobs,public.federal_identity_remediation_receipts from public,anon,authenticated;
grant all on public.company_federal_identity_claims,public.company_related_government_entities,public.federal_identity_jobs,public.federal_identity_remediation_receipts to service_role;
revoke all on public.federal_identity_candidate_receipts from public,anon,authenticated;
grant all on public.federal_identity_candidate_receipts to service_role;

create function public.federal_identity_match_needs_repair(m company_government_matches) returns boolean language sql immutable as $$
 select m.match_method in ('name_only','domain_only','exact_name_state','exact_name_city_state')
  or (m.match_method='domain' and not(coalesce(m.evidence->'nameMatch'='true'::jsonb,false) and coalesce(m.evidence->'domainMatch'='true'::jsonb,false)))
  or (m.match_method='exact_name_address' and not(coalesce(m.evidence->'nameMatch'='true'::jsonb,false) and coalesce(m.evidence->'addressMatch'='true'::jsonb,false)
   and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(m.evidence->'addressEvidence')='array' then m.evidence->'addressEvidence' else '[]'::jsonb end) a
    where a->'streetMatch'='true'::jsonb and a->'supportsIdentity'='true'::jsonb)));
$$;
create function public.federal_identity_claim_job(p_weak_only boolean default false) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j federal_identity_jobs; tok uuid:=gen_random_uuid(); continuation_turn boolean:=mod(floor(extract(epoch from now())/300)::bigint,3)<>0;
begin
 insert into federal_identity_jobs(company_id)
 select c.id from companies c where c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam'
 and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and not exists(select 1 from federal_identity_jobs x where x.company_id=c.id)
 and (exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='verified' and federal_identity_match_needs_repair(m))
  or exists(select 1 from intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded and
   (jsonb_array_length(case when jsonb_typeof(o.metadata->'identityClaims')='array' then o.metadata->'identityClaims' else '[]'::jsonb end)>0
    or o.evidence_text ~* '(doing business as|formerly known as|legal name|subsidiary of|joint venture|a division of|acquired by)')))
 and (not p_weak_only or exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='verified' and federal_identity_match_needs_repair(m)))
 order by exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='verified'
   and federal_identity_match_needs_repair(m)) desc,c.id limit 200
 on conflict do nothing;
 select w.* into j from federal_identity_jobs w join companies c on c.id=w.company_id
 where (p_weak_only or w.due_at<=now()) and (w.lease_expires_at is null or w.lease_expires_at<=now())
 and c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
 and (not p_weak_only or exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='verified'
  and federal_identity_match_needs_repair(m) and not exists(select 1 from federal_identity_remediation_receipts r where r.match_id=m.id and r.created_at>now()-interval '7 days')))
 -- Two ordinary slots prefer due continuations; every third prefers new
 -- evidence. Both pools progress without charging for empty-account scans.
 order by case when p_weak_only then 0
  when exists(select 1 from company_federal_identity_claims q where q.company_id=w.company_id and q.status in ('pending','searching'))=continuation_turn then 0 else 1 end,
  w.due_at,w.attempts,w.company_id for update of w skip locked limit 1;
 if not found then return null; end if;
 update federal_identity_jobs set lease_token=tok,lease_expires_at=now()+interval '4 minutes',attempts=attempts+1,updated_at=now()
 where company_id=j.company_id returning * into j;
 return to_jsonb(j);
end $$;
create function public.federal_identity_repair_snapshot(p_offset integer default 0) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare answer jsonb;
begin
 if p_offset<0 or p_offset>100000 then raise exception 'invalid repair offset'; end if;
 with weak as (
  select m.id as match_id,m.company_id,m.government_entity_id,m.match_method,c.name,
    r.outcome as last_outcome,r.created_at as receipt_at,
    coalesce(j.lease_expires_at>now(),false) as leased,
    case when j.lease_expires_at>now() then 'leased' when r.id is not null then 'awaiting_new_evidence' else 'eligible' end as state
  from company_government_matches m join companies c on c.id=m.company_id
  left join federal_identity_jobs j on j.company_id=c.id
  left join lateral (select x.* from federal_identity_remediation_receipts x where x.match_id=m.id and x.created_at>now()-interval '7 days' order by x.created_at desc,x.id desc limit 1) r on true
  where m.match_status='verified' and federal_identity_match_needs_repair(m)
    and c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
 ), outcomes as (select outcome,count(*) as total from federal_identity_remediation_receipts where created_at>now()-interval '7 days' group by outcome)
 select jsonb_build_object('observedAt',now(),'currentWeakTotal',(select count(*) from weak),
  'outstandingEligible',(select count(*) from weak where state='eligible'),'leased',(select count(*) from weak where state='leased'),
  'awaitingNewEvidence',(select count(*) from weak where state='awaiting_new_evidence'),'offset',p_offset,'limit',200,
  'candidates',(select coalesce(jsonb_agg(to_jsonb(w)),'[]') from (select * from weak order by match_id offset p_offset limit 200) w),
  'recentOutcomeCounts',(select coalesce(jsonb_object_agg(outcome,total),'{}') from outcomes),
  'scope','Read-only snapshot. Zero eligible can still mean active leases or unresolved evidence; no claim, provider call, or repair replay.') into answer;
 return answer;
end $$;
revoke all on function public.federal_identity_repair_snapshot(integer) from public,anon,authenticated;
grant execute on function public.federal_identity_repair_snapshot(integer) to service_role;
create function public.federal_identity_finish_job(p_company uuid,p_lease uuid,p_cursor jsonb,p_receipt jsonb,p_pending boolean)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
 update federal_identity_jobs set cursor=p_cursor,last_receipt=p_receipt,due_at=now()+case when p_pending then interval '5 minutes' else interval '7 days' end,
 lease_token=null,lease_expires_at=null,updated_at=now() where company_id=p_company and lease_token=p_lease and lease_expires_at>now();
 return found;
end $$;

-- A receipt is written before and after the CAS in the same transaction. No
-- entity, award, transaction, TAM membership or grade is deleted or rewritten.
create function public.federal_identity_repair_match(p_company uuid,p_lease uuid,p_match uuid,p_before jsonb,p_outcome text,p_decision jsonb,p_evidence jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m company_government_matches; audit_id uuid; related boolean; trigger_images jsonb:='[]';
begin
 if not exists(select 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now()) then raise exception 'identity lease lost'; end if;
 select * into m from company_government_matches where id=p_match and company_id=p_company for update;
 if not found or to_jsonb(m) is distinct from p_before then return jsonb_build_object('outcome','stale'); end if;
 if m.match_status<>'verified' or p_outcome not in ('strengthened_direct','related_context','needs_evidence') then raise exception 'invalid identity repair'; end if;
 related:=exists(select 1 from company_related_government_entities r join company_federal_identity_claims c on c.id=r.claim_id
  join intelligence_observations o on o.id=c.observation_id where r.company_id=p_company and r.government_entity_id=m.government_entity_id and o.is_current and not o.feedback_excluded);
 if p_outcome='related_context' and not related then raise exception 'missing sourced related binding'; end if;
 if p_outcome='strengthened_direct' and (p_decision->>'status'<>'verified' or p_decision->>'method' not in ('domain','exact_name_address')
   or not (coalesce((p_decision#>>'{evidence,nameMatch}')::boolean,false) and
     (coalesce((p_decision#>>'{evidence,domainMatch}')::boolean,false) or coalesce((p_decision#>>'{evidence,addressMatch}')::boolean,false)))) then raise exception 'unsupported direct repair'; end if;
 insert into federal_identity_remediation_receipts(match_id,company_id,before_image,outcome,evidence)
 values(m.id,p_company,to_jsonb(m),p_outcome,p_evidence) returning id into audit_id;
 if p_outcome='strengthened_direct' then
   update company_government_matches set match_method=p_decision->>'method',confidence=(p_decision->>'confidence')::numeric,
    evidence=(p_decision->'evidence')||jsonb_build_object('remediationReceiptId',audit_id,'identityPolicy','identity-evidence-v2'),
    verified_by='source_identity_repair',verified_at=now(),updated_at=now() where id=m.id;
 elsif p_outcome='related_context' then
   update company_government_matches set match_status='pending',match_method='sourced_related_context',
    evidence=m.evidence||jsonb_build_object('remediationReceiptId',audit_id,'relatedContextOnly',true),updated_at=now() where id=m.id;
   select coalesce(jsonb_agg(to_jsonb(t)),'[]') into trigger_images from triggers t where t.company_id=p_company and
    (exists(select 1 from federal_awards a where a.government_entity_id=m.government_entity_id and
      (t.metadata->>'generatedAwardId'=a.generated_award_id or t.metadata->>'awardId'=a.award_id or t.metadata->>'federalAwardId'=a.id::text))
     or t.dedupe_key like 'contract-metrics:%');
   update triggers t set strength=0,metadata=t.metadata||jsonb_build_object('identityRemediationReceiptId',audit_id,'identityReclassified',true)
    where t.id in (select (v->>'id')::uuid from jsonb_array_elements(trigger_images) v);
 end if;
 update federal_identity_remediation_receipts set after_image=(select to_jsonb(x) from company_government_matches x where x.id=m.id),trigger_before_images=trigger_images where id=audit_id;
 return jsonb_build_object('outcome',p_outcome,'receiptId',audit_id);
end $$;

create function public.federal_identity_bind_candidate(p_company uuid,p_lease uuid,p_claim uuid,p_entity jsonb,p_decision jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare q company_federal_identity_claims; entity_id uuid; recipient_entity uuid; g government_entities;
begin
 perform 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now() for update;
 if not found then raise exception 'identity lease lost'; end if;
 select c.* into q from company_federal_identity_claims c join intelligence_observations o on o.id=c.observation_id
 where c.id=p_claim and c.company_id=p_company and o.is_current and not o.feedback_excluded;
 if not found then raise exception 'identity source changed'; end if;
 if p_entity->>'uei' !~ '^[A-Z0-9]{12}$' or p_decision->>'status' is distinct from 'verified'
   or p_decision->>'method' not in ('domain','exact_name_address') then raise exception 'unsupported candidate binding'; end if;
 select id into entity_id from government_entities where uei=p_entity->>'uei';
 select id into recipient_entity from government_entities where usaspending_recipient_id=p_entity->>'usaspending_recipient_id';
 if entity_id is not null and recipient_entity is not null and entity_id<>recipient_entity then raise exception 'conflicting recipient identifiers'; end if;
 entity_id:=coalesce(entity_id,recipient_entity);
 if entity_id is null then
  insert into government_entities(uei,usaspending_recipient_id,legal_name,address_line1,city,state,postal_code,country_code,source,source_url,evidence)
  values(p_entity->>'uei',p_entity->>'usaspending_recipient_id',p_entity->>'legal_name',p_entity->>'address_line1',p_entity->>'city',p_entity->>'state',p_entity->>'postal_code',p_entity->>'country_code',
   'usaspending',p_entity->>'source_url',jsonb_build_object('identityClaimId',q.id)) on conflict do nothing returning id into entity_id;
  if entity_id is null then select id into entity_id from government_entities where uei=p_entity->>'uei'; end if;
 end if;
 select * into g from government_entities where id=entity_id;
 if g.id is null or (g.uei is not null and g.uei<>p_entity->>'uei') or (g.usaspending_recipient_id is not null and p_entity->>'usaspending_recipient_id' is not null
   and g.usaspending_recipient_id<>p_entity->>'usaspending_recipient_id') then raise exception 'conflicting stored entity'; end if;
 if q.relationship in ('legal_name','dba','former_name') then
  if exists(select 1 from company_government_matches where company_id=p_company and government_entity_id=entity_id and match_status<>'verified') then raise exception 'existing identity review must be retained'; end if;
  insert into company_government_matches(company_id,government_entity_id,match_status,match_method,confidence,evidence,verified_by,verified_at)
  values(p_company,entity_id,'verified',p_decision->>'method',(p_decision->>'confidence')::numeric,
   (p_decision->'evidence')||jsonb_build_object('identityClaimId',q.id),'sourced_identity_discovery',now()) on conflict do nothing;
 else
  insert into company_related_government_entities(company_id,government_entity_id,claim_id,relationship,evidence)
  values(p_company,entity_id,q.id,q.relationship,jsonb_build_object('sourceUrl',q.source_url,'observedAt',q.captured_at,'subjectName',q.subject_name,
   'candidateName',q.candidate_name,'sourceQuote',q.source_quote,'binding',p_decision)) on conflict do nothing;
 end if;
 return entity_id;
end $$;

-- Extend bounded identity context with public, account-anchored direct aliases.
create or replace function public.company_identity_source_context(p_company_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
  'record',(select jsonb_build_object('id',d.id,'header',left(d.body,6000),'capturedAt',d.captured_at) from lead_documents d
   where d.netsuite_internal_id=c.netsuite_internal_id and (d.company_id is null or d.company_id=c.id) and d.doc_type='record_text' order by d.captured_at desc nulls last,d.id desc limit 1),
  'websites',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'url',x.source_url,'capturedAt',x.observed_at,'identity',x.metadata->'companyIdentity'))
   from (select id,source_url,observed_at,metadata from intelligence_observations where company_id=c.id and is_current and not feedback_excluded
   and source_kind='website' and jsonb_typeof(metadata->'companyIdentity')='object' order by observed_at desc,id desc limit 8) x),'[]'::jsonb),
  'claims',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'name',x.candidate_name,'subjectName',x.subject_name,'relationship',x.relationship,'sourceUrl',x.source_url,'capturedAt',x.captured_at))
   from (select q.* from company_federal_identity_claims q join intelligence_observations o on o.id=q.observation_id
    where q.company_id=c.id and q.relationship in ('legal_name','dba','former_name') and o.is_current and not o.feedback_excluded order by q.captured_at desc limit 20) x),'[]'::jsonb))
 from companies c where c.id=p_company_id and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));
$$;
revoke all on function public.federal_identity_claim_job(boolean),public.federal_identity_finish_job(uuid,uuid,jsonb,jsonb,boolean),public.federal_identity_repair_match(uuid,uuid,uuid,jsonb,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.federal_identity_claim_job(boolean),public.federal_identity_finish_job(uuid,uuid,jsonb,jsonb,boolean),public.federal_identity_repair_match(uuid,uuid,uuid,jsonb,text,jsonb,jsonb) to service_role;
revoke all on function public.federal_identity_bind_candidate(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.federal_identity_bind_candidate(uuid,uuid,uuid,jsonb,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
