-- Jev decisions use existing sourced-identity leases and repair receipts.
-- No scheduler, CRM refresh, membership/grade changes or model confidence gate.
begin;
create function public.federal_identity_supported_direct(d jsonb) returns boolean
language sql immutable set search_path=public,pg_temp as $$
 select coalesce(d->>'status'='verified' and (
  (d->>'method' in ('domain','exact_name_address') and d#>>'{evidence,nameMatch}'='true'
   and (d#>>'{evidence,domainMatch}'='true' or d#>>'{evidence,addressMatch}'='true'))
  or (d->>'method'='jev_identity' and d#>>'{evidence,jevIdentity,outcome}'='same_company'
   and d#>>'{evidence,jevIdentity,decision,evidence,sourceGrounded}'='true'
   and jsonb_typeof(d#>'{evidence,jevIdentity,nativeJev,answers}')='object'
   and length(d#>>'{evidence,jevIdentity,requestFingerprint}')=64
   and jsonb_array_length(coalesce(d#>'{evidence,jevIdentity,supportingSourceIds}','[]'))>0)
 ),false);
$$;
revoke all on function public.federal_identity_supported_direct(jsonb) from public,anon,authenticated;
grant execute on function public.federal_identity_supported_direct(jsonb) to service_role;

create function public.federal_identity_sources_current(p_company uuid,d jsonb) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce(d->>'method'<>'jev_identity' or exists(
  select 1 from intelligence_observations o where o.company_id=p_company and o.is_current and not o.feedback_excluded
  and o.id::text in (select jsonb_array_elements_text(coalesce(d#>'{evidence,jevIdentity,supportingSourceIds}','[]')))
 ),false);
$$;
revoke all on function public.federal_identity_sources_current(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.federal_identity_sources_current(uuid,jsonb) to service_role;

create or replace function public.federal_identity_repair_match(p_company uuid,p_lease uuid,p_match uuid,p_before jsonb,p_outcome text,p_decision jsonb,p_evidence jsonb)
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
 if p_outcome='strengthened_direct' and (not public.federal_identity_supported_direct(p_decision) or not public.federal_identity_sources_current(p_company,p_decision)) then raise exception 'unsupported direct repair'; end if;
 insert into federal_identity_remediation_receipts(match_id,company_id,before_image,outcome,evidence)
 values(m.id,p_company,to_jsonb(m),p_outcome,p_evidence) returning id into audit_id;
 if p_outcome='strengthened_direct' then
   update company_government_matches set match_method=p_decision->>'method',confidence=(p_decision->>'confidence')::numeric,
    evidence=(p_decision->'evidence')||jsonb_build_object('remediationReceiptId',audit_id,'identityPolicy','identity-evidence-v2'),
    verified_by=case when p_decision->>'method'='jev_identity' then 'jev_identity' else 'source_identity_repair' end,verified_at=now(),updated_at=now() where id=m.id;
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
create or replace function public.federal_identity_bind_candidate(p_company uuid,p_lease uuid,p_claim uuid,p_entity jsonb,p_decision jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare q company_federal_identity_claims; entity_id uuid; recipient_entity uuid; g government_entities;
begin
 perform 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now() for update;
 if not found then raise exception 'identity lease lost'; end if;
 select c.* into q from company_federal_identity_claims c join intelligence_observations o on o.id=c.observation_id
 where c.id=p_claim and c.company_id=p_company and o.is_current and not o.feedback_excluded;
 if not found then raise exception 'identity source changed'; end if;
 if p_entity->>'uei' !~ '^[A-Z0-9]{12}$' or p_decision->>'status' is distinct from 'verified'
   or not public.federal_identity_supported_direct(p_decision) or not public.federal_identity_sources_current(p_company,p_decision) then raise exception 'unsupported candidate binding'; end if;
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
create or replace function public.federal_identity_claim_job(p_weak_only boolean default false) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare j federal_identity_jobs; tok uuid:=gen_random_uuid(); continuation_turn boolean:=mod(floor(extract(epoch from now())/300)::bigint,3)<>0;
begin
 insert into federal_identity_jobs(company_id)
 select c.id from companies c where c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam'
 and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))) and not exists(select 1 from federal_identity_jobs x where x.company_id=c.id)
 and (exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='verified' and federal_identity_match_needs_repair(m))
  or (not p_weak_only and exists(select 1 from company_government_matches m where m.company_id=c.id and m.match_status='pending'))
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

create function public.federal_identity_next_pending_match(p_company uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m company_government_matches; pending boolean;
begin
 if not exists(select 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now()) then raise exception 'identity lease lost'; end if;
 select x.* into m from company_government_matches x where x.company_id=p_company and x.match_status='pending'
 and not exists(select 1 from federal_identity_remediation_receipts r where r.match_id=x.id and r.policy_version='jev-recipient-v1' and r.created_at>now()-interval '7 days')
 order by x.updated_at,x.id limit 1;
 if not found then return jsonb_build_object('match',null,'pending',false); end if;
 select exists(select 1 from company_government_matches x where x.company_id=p_company and x.id<>m.id and x.match_status='pending'
 and not exists(select 1 from federal_identity_remediation_receipts r where r.match_id=x.id and r.policy_version='jev-recipient-v1' and r.created_at>now()-interval '7 days')) into pending;
 return jsonb_build_object('match',to_jsonb(m),'pending',pending);
end $$;
create function public.federal_identity_finish_pending_match(p_company uuid,p_lease uuid,p_before jsonb,p_decision jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m company_government_matches; saved jsonb;
begin
 if not exists(select 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now()) then raise exception 'identity lease lost'; end if;
 select * into m from company_government_matches where id=(p_before->>'id')::uuid and company_id=p_company for update;
 if not found or to_jsonb(m) is distinct from p_before or m.match_status<>'pending' then return jsonb_build_object('outcome','stale'); end if;
 if p_decision->>'status'='verified' and (not public.federal_identity_supported_direct(p_decision) or not public.federal_identity_sources_current(p_company,p_decision)) then raise exception 'unsupported pending repair'; end if;
 saved:=public.government_identity_save_match(p_company,m.government_entity_id,p_decision)->'match';
 insert into federal_identity_remediation_receipts(match_id,company_id,policy_version,before_image,after_image,outcome,evidence)
 values(m.id,p_company,'jev-recipient-v1',to_jsonb(m),saved,coalesce(p_decision#>>'{evidence,jevIdentity,outcome}',p_decision->>'status'),p_decision->'evidence');
 return jsonb_build_object('outcome','recorded','matchStatus',saved->>'match_status');
end $$;
revoke all on function public.federal_identity_next_pending_match(uuid,uuid),public.federal_identity_finish_pending_match(uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.federal_identity_next_pending_match(uuid,uuid),public.federal_identity_finish_pending_match(uuid,uuid,jsonb,jsonb) to service_role;
create or replace function public.government_identity_save_match(p_company uuid,p_entity uuid,p_decision jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare existing company_government_matches; saved company_government_matches; disposition text;
begin
 if p_company is null or p_entity is null or jsonb_typeof(p_decision) is distinct from 'object'
  or coalesce(p_decision->>'status','') not in ('pending','verified','rejected')
  or nullif(btrim(p_decision->>'method'),'') is null or length(p_decision->>'method')>100
  or jsonb_typeof(p_decision->'confidence') is distinct from 'number'
  or (p_decision->>'confidence')::numeric not between 0 and 1
  or jsonb_typeof(p_decision->'evidence') is distinct from 'object' or octet_length(p_decision::text)>524288
  then raise exception 'invalid government match decision'; end if;
 if p_decision->>'status'='verified' and p_decision->>'method'='jev_identity'
  and (not public.federal_identity_supported_direct(p_decision) or not public.federal_identity_sources_current(p_company,p_decision)) then raise exception 'unsupported Jev identity source'; end if;
 perform pg_advisory_xact_lock(hashtextextended('government_identity_match:'||p_company::text||':'||p_entity::text,0));
 select * into existing from company_government_matches where company_id=p_company and government_entity_id=p_entity for update;
 if not found then
  insert into company_government_matches(company_id,government_entity_id,match_status,match_method,confidence,evidence,verified_by,verified_at)
  values(p_company,p_entity,p_decision->>'status',p_decision->>'method',(p_decision->>'confidence')::numeric,p_decision->'evidence',
   case when p_decision->>'status'='verified' then case when p_decision->>'method'='jev_identity' then 'jev_identity' else 'deterministic' end end,
   case when p_decision->>'status'='verified' then now() end)
  on conflict do nothing returning * into saved;
  if found then return jsonb_build_object('match',to_jsonb(saved),'disposition','inserted'); end if;
  select * into existing from company_government_matches where company_id=p_company and government_entity_id=p_entity for update;
  if not found then raise exception 'government match collision could not be reconciled'; end if;
 end if;
 if existing.match_status in ('verified','rejected') then
  return jsonb_build_object('match',to_jsonb(existing),'disposition','preserved_'||existing.match_status);
 end if;
 update company_government_matches set match_status=p_decision->>'status',match_method=p_decision->>'method',
  confidence=(p_decision->>'confidence')::numeric,evidence=p_decision->'evidence',
  verified_by=case when p_decision->>'status'='verified' then case when p_decision->>'method'='jev_identity' then 'jev_identity' else 'deterministic' end end,
  verified_at=case when p_decision->>'status'='verified' then now() end,updated_at=now()
 where id=existing.id returning * into saved;
 return jsonb_build_object('match',to_jsonb(saved),'disposition','updated');
end $$;
-- Admit previously unresolved identities to the existing leased worker. Do not
-- alter a live lease or its cursor, or modify any source sweep's fences.
insert into federal_identity_jobs(company_id)
select distinct c.id from companies c join company_government_matches m on m.company_id=c.id
where m.match_status='pending' and c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam'
and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
on conflict(company_id) do update set due_at=least(federal_identity_jobs.due_at,now());
notify pgrst,'reload schema';
commit;
