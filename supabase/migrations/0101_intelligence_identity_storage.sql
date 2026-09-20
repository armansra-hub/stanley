-- Ordinary source refreshes cannot merge conflicting federal identifiers or
-- reverse an explicit identity decision. Remediation retains its separate CAS.
create function public.government_identity_save_entity(p_entity jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare
 requested_uei text:=nullif(upper(btrim(p_entity->>'uei')),'');
 requested_cage text:=nullif(upper(btrim(p_entity->>'cage_code')),'');
 requested_recipient text:=nullif(btrim(p_entity->>'usaspending_recipient_id'),'');
 original government_entities; matched government_entities; incoming government_entities;
 payload jsonb; matches integer; attempt integer;
begin
 if jsonb_typeof(p_entity) is distinct from 'object' or octet_length(p_entity::text)>524288
   or nullif(btrim(p_entity->>'legal_name'),'') is null or nullif(btrim(p_entity->>'source'),'') is null
   or (requested_uei is null and requested_cage is null and requested_recipient is null)
   or (requested_uei is not null and requested_uei !~ '^[A-Z0-9]{12}$')
   or (requested_cage is not null and requested_cage !~ '^[A-Z0-9]{5}$')
   or length(requested_recipient)>500
   or (p_entity ? 'evidence' and p_entity->'evidence'<>'null'::jsonb and jsonb_typeof(p_entity->'evidence')<>'object')
   then raise exception 'invalid government entity identity'; end if;
 -- One short shared critical section also serializes disjoint-key enrichment
 -- (e.g. UEI-only versus CAGE-only) before either can overwrite a known key.
 perform pg_advisory_xact_lock(hashtextextended('government_identity_entities',0));
 payload:=jsonb_strip_nulls(p_entity-'id'-'observed_at')
   -'uei'-'cage_code'-'usaspending_recipient_id';
 payload:=payload||jsonb_strip_nulls(jsonb_build_object('uei',requested_uei,'cage_code',requested_cage,
   'usaspending_recipient_id',requested_recipient))||jsonb_build_object('observed_at',now());
 if jsonb_typeof(payload->'evidence'->'addressLine2')='string' and nullif(btrim(payload->'evidence'->>'addressLine2'),'') is not null then
  -- A later award source may have another first line. Retain the SAM unit as
  -- sourced history, but readers may combine it only with this exact first line.
  payload:=jsonb_set(payload,'{evidence}',(payload->'evidence')||jsonb_build_object(
   'addressLine2AddressLine1',payload->>'address_line1','addressLine2SourceUrl',payload->>'source_url','addressLine2ObservedAt',now()));
 end if;
 for attempt in 1..2 loop
  original:=null; matches:=0;
  for matched in select g.* from government_entities g where
   (requested_uei is not null and upper(g.uei)=requested_uei)
   or (requested_cage is not null and upper(g.cage_code)=requested_cage)
   or (requested_recipient is not null and g.usaspending_recipient_id=requested_recipient)
   order by g.id for update loop
   matches:=matches+1; original:=matched;
  end loop;
  if matches>1 then raise exception 'conflicting government identifier mappings'; end if;
  if original.id is not null then
   if (requested_uei is not null and original.uei is not null and upper(original.uei)<>requested_uei)
    or (requested_cage is not null and original.cage_code is not null and upper(original.cage_code)<>requested_cage)
    or (requested_recipient is not null and original.usaspending_recipient_id is not null and original.usaspending_recipient_id<>requested_recipient)
     then raise exception 'conflicting stored government identifiers'; end if;
   incoming:=jsonb_populate_record(original,payload);
   incoming.evidence:=coalesce(original.evidence,'{}')||coalesce(payload->'evidence','{}');
   update government_entities set uei=incoming.uei,cage_code=incoming.cage_code,usaspending_recipient_id=incoming.usaspending_recipient_id,
    legal_name=incoming.legal_name,dba_name=incoming.dba_name,website=incoming.website,domain=incoming.domain,address_line1=incoming.address_line1,
    city=incoming.city,state=incoming.state,postal_code=incoming.postal_code,country_code=incoming.country_code,
    registration_status=incoming.registration_status,registration_date=incoming.registration_date,expiration_date=incoming.expiration_date,
    entity_start_date=incoming.entity_start_date,parent_uei=incoming.parent_uei,parent_name=incoming.parent_name,source=incoming.source,
    source_url=incoming.source_url,source_updated_at=incoming.source_updated_at,observed_at=now(),payload_hash=incoming.payload_hash,evidence=incoming.evidence
    where id=original.id;
   return original.id;
  end if;
  incoming:=jsonb_populate_record(null::government_entities,payload);
  insert into government_entities(uei,cage_code,usaspending_recipient_id,legal_name,dba_name,website,domain,address_line1,city,state,postal_code,country_code,
   registration_status,registration_date,expiration_date,entity_start_date,parent_uei,parent_name,source,source_url,source_updated_at,observed_at,payload_hash,evidence)
  values(incoming.uei,incoming.cage_code,incoming.usaspending_recipient_id,incoming.legal_name,incoming.dba_name,incoming.website,incoming.domain,
   incoming.address_line1,incoming.city,incoming.state,incoming.postal_code,incoming.country_code,incoming.registration_status,incoming.registration_date,
   incoming.expiration_date,incoming.entity_start_date,incoming.parent_uei,incoming.parent_name,incoming.source,incoming.source_url,
   incoming.source_updated_at,now(),incoming.payload_hash,coalesce(incoming.evidence,'{}')) on conflict do nothing returning * into matched;
  if found then return matched.id; end if;
  -- A legacy writer outside this advisory lock may have won insertion. Re-read
  -- ALL supplied identifiers on the next iteration before accepting its row.
 end loop;
 raise exception 'government entity collision could not be reconciled';
end $$;

create function public.government_identity_save_match(p_company uuid,p_entity uuid,p_decision jsonb)
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

revoke all on function public.government_identity_save_entity(jsonb),public.government_identity_save_match(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.government_identity_save_entity(jsonb),public.government_identity_save_match(uuid,uuid,jsonb) to service_role;
