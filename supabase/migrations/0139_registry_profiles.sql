-- Sourced baseline facts reuse lead_insights. No queue, trigger, grade or
-- membership changes; the existing insight writer remains the only publisher.
begin;
alter table public.lead_insights add column if not exists registry_profile jsonb;
alter table public.lead_insights drop constraint if exists lead_insights_source_check;
alter table public.lead_insights add constraint lead_insights_source_check
  check(source in ('linkedin','website','record','registry'));
alter table public.lead_insights add constraint lead_insights_registry_profile_check
  check((source='registry' and kind='ops_profile' and registry_profile is not null and jsonb_typeof(registry_profile)='object'
    and registry_profile->>'version'='1') or (source<>'registry' and registry_profile is null));

create function public.registry_profiles_publish(p_rows jsonb,p_agent text default 'codex')
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; company public.companies%rowtype; saved public.lead_insights%rowtype;
  event_id uuid := gen_random_uuid(); stamp timestamptz := clock_timestamp(); changed integer := 0;
  result jsonb := '[]'::jsonb; profile jsonb; profile_key text; canonical_count integer;
begin
  if p_rows is null or jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) not between 1 and 50 then raise exception 'registry_batch_invalid'; end if;
  for item in select value from jsonb_array_elements(p_rows) loop
    if coalesce(item->>'netsuite_internal_id','') !~ '^[0-9]+$' or item->>'source' is distinct from 'registry' or item->>'kind' is distinct from 'ops_profile'
      or item->'registry_profile'->>'version' is distinct from '1' or coalesce(item->>'content_hash','') !~ '^[a-f0-9]{64}$' then raise exception 'registry_payload_invalid'; end if;
    select * into company from public.companies where id=(item->>'company_id')::uuid for update;
    if not found or company.netsuite_internal_id is distinct from item->>'netsuite_internal_id'
      or 'tam_duplicate'=any(coalesce(company.lists,'{}'::text[])) then raise exception 'registry_company_changed'; end if;
    select count(*) into canonical_count from public.companies c where c.netsuite_internal_id=company.netsuite_internal_id
      and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));
    if canonical_count<>1 then raise exception 'registry_company_ambiguous'; end if;
    profile_key := 'registry:'||(item->'registry_profile'->>'dataset')||':'||(item->'registry_profile'->>'recordId');
    if profile_key is null or profile_key is distinct from item->>'label' then raise exception 'registry_key_invalid'; end if;
    select * into saved from public.lead_insights where company_id=company.id and source='registry' and kind='ops_profile' and label=profile_key for update;
    if found and saved.registry_profile #>> '{publication,contentHash}'=item->>'content_hash' then
      result := result||jsonb_build_array(to_jsonb(saved));
      continue;
    end if;
    if found and saved.registry_profile->>'sourceAsOf' is not null and (item->'registry_profile'->>'sourceAsOf' is null
      or (item->'registry_profile'->>'sourceAsOf')::date < (saved.registry_profile->>'sourceAsOf')::date) then raise exception 'registry_stale_source'; end if;
    profile := (item->'registry_profile')||jsonb_build_object('publication',jsonb_build_object('contentHash',item->>'content_hash','eventId',event_id,'publishedAt',stamp));
    insert into public.lead_insights(company_id,netsuite_internal_id,source,kind,label,detail,evidence,evidence_url,confidence,posted_at,registry_profile)
      values(company.id,company.netsuite_internal_id,'registry','ops_profile',profile_key,item->>'detail',item->>'evidence',item->>'evidence_url','high',
        (profile->>'sourceAsOf')::date,profile)
      on conflict(company_id,source,kind,label) do update set detail=excluded.detail,evidence=excluded.evidence,evidence_url=excluded.evidence_url,
        confidence=excluded.confidence,posted_at=excluded.posted_at,registry_profile=excluded.registry_profile
      returning * into saved;
    changed := changed+1;
    result := result||jsonb_build_array(to_jsonb(saved));
  end loop;
  if changed>0 then
    insert into public.app_events(id,module,kind,entity_type,summary,meta) values(event_id,'headhunter','registry.profiles_recorded','agent_bridge',
      changed||' verified public registry baseline profiles saved',jsonb_build_object('agent',p_agent,'changed',changed,
        'receipts',(select jsonb_agg(jsonb_build_object('id',v->>'id','companyId',v->>'company_id','internalId',v->>'netsuite_internal_id',
          'profileKey',v->>'label','contentHash',v #>> '{registry_profile,publication,contentHash}')) from jsonb_array_elements(result) v)));
  end if;
  return jsonb_build_object('changed',changed,'rows',result,'eventId',case when changed>0 then event_id else null end);
end $$;
revoke all on function public.registry_profiles_publish(jsonb,text) from public,anon,authenticated;
grant execute on function public.registry_profiles_publish(jsonb,text) to service_role;
notify pgrst,'reload schema';
commit;
