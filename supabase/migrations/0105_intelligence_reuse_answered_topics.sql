begin;

-- This verifies availability of already-paid answers, not their substantive
-- judgment. Only the current full classification contract can satisfy a new
-- directed-research pass; negative/unknown answers are reusable too.
create function public.intelligence_packet_criteria_cover(p_attributes jsonb,p_criteria jsonb,p_characters jsonb)
returns boolean language plpgsql immutable set search_path=public,pg_temp as $$
declare packet jsonb; criterion text; expected text[]; cursor_at integer:=0; finish_at integer; total integer;
begin
  if jsonb_typeof(p_criteria) is distinct from 'array' or jsonb_array_length(p_criteria) not between 1 and 10
    or jsonb_typeof(p_characters) is distinct from 'number' or p_characters::text !~ '^[0-9]{1,6}$'
    or jsonb_typeof(p_attributes->'packetFindings') is distinct from 'array'
    or jsonb_array_length(p_attributes->'packetFindings')=0 then return false; end if;
  if exists(select 1 from jsonb_array_elements(p_criteria) value where jsonb_typeof(value)<>'string'
    or trim(both '"' from value::text)!~'^[a-z][a-z0-9_]{0,59}$') then return false; end if;
  select array_agg(value) into expected from jsonb_array_elements_text(p_criteria) value;
  if not (expected @> array['project_delivery','multi_entity','multi_location']) then return false; end if;
  total:=(p_characters::text)::integer;
  if total<1 or (p_attributes->>'analyzedCharacters') is distinct from total::text
    or (p_attributes->>'retainedCharacters') is distinct from total::text then return false; end if;
  -- Native packet order follows source order; do not sort away overlaps/gaps.
  for packet in select value from jsonb_array_elements(p_attributes->'packetFindings') loop
    if coalesce(packet->>'questionVersion','') not in ('stanley-business-services-v3','stanley-business-services-v4')
      or (packet->>'start') is distinct from cursor_at::text
      or coalesce(packet->>'end','') !~ '^[0-9]{1,6}$'
      or jsonb_typeof(packet->'criteria') is distinct from 'object'
      or not ((packet->'criteria') ?& expected) then return false; end if;
    finish_at:=(packet->>'end')::integer;
    if finish_at<=cursor_at or finish_at>total then return false; end if;
    foreach criterion in array expected loop
      if jsonb_typeof(packet->'criteria'->criterion) is distinct from 'number'
        or (packet->'criteria'->>criterion)::numeric not between 0 and 1 then return false; end if;
    end loop;
    cursor_at:=finish_at;
  end loop;
  return cursor_at=total;
end $$;
revoke all on function public.intelligence_packet_criteria_cover(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_packet_criteria_cover(jsonb,jsonb,jsonb) to service_role;

create or replace function public.intelligence_observe(p_company uuid, p_source_key text, p_source_kind text,
  p_url text, p_title text, p_text text, p_hash text, p_event_date timestamptz,
  p_observed_at timestamptz, p_metadata jsonb, p_sections jsonb, p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_queued boolean := false; v_discovery_key text; v_context jsonb; v_effective_hash text;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then
    return jsonb_build_object('disabled',true);
  end if;
  if not exists(select 1 from companies where id=p_company and status <> 'removed_from_tam') then
    raise exception 'Account is not eligible for intelligence';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || p_source_key,0));
  v_context := intelligence_observation_context(p_source_kind,p_metadata);
  select content_hash into v_effective_hash from intelligence_observations
    where company_id=p_company and source_key=p_source_key
      and (content_hash=p_hash or metadata->>'documentContentHash'=p_hash)
      and intelligence_observation_context(source_kind,metadata)=v_context
    order by observed_at desc,id desc limit 1;
  -- A directed pass can narrow/reorder its research gaps after other sources
  -- answer them. Reuse a finished native answer only when every packet already
  -- contains every criterion this exact pass would ask. Source text, dates,
  -- identity, kind and all other interpretation context must still match.
  if v_effective_hash is null and jsonb_typeof(p_metadata->'researchCriteria')='array' then
    select o.content_hash into v_effective_hash from intelligence_observations o
      where o.company_id=p_company and o.source_key=p_source_key and o.is_current and not o.feedback_excluded
        and (o.content_hash=p_hash or o.metadata->>'documentContentHash'=p_hash)
        and (intelligence_observation_context(o.source_kind,o.metadata)-'researchTopics')=(v_context-'researchTopics')
        and exists(select 1 from intelligence_jobs j where j.observation_id=o.id and j.kind='interpret' and j.status='complete')
        and intelligence_packet_criteria_cover(o.attributes,p_metadata->'researchCriteria',p_metadata->'retainedCharacters')
      order by o.observed_at desc,o.id desc limit 1;
  end if;
  if v_effective_hash is null then
    -- Leave ordinary legacy identities alone. A new material context gets a
    -- separate answer only when the existing base identity is incompatible.
    v_effective_hash := case when exists(select 1 from intelligence_observations
      where company_id=p_company and source_key=p_source_key and content_hash=p_hash)
      then encode(sha256(convert_to(p_hash || ':' || v_context::text,'UTF8')),'hex') else p_hash end;
  end if;
  -- Different source kinds and targeted question packs are separate capture
  -- streams. A news answer must not retire a website's reusable identity, and
  -- asking about a new topic must not erase the earlier topic answers.
  update intelligence_observations set is_current=false
    where company_id=p_company and source_key=p_source_key and content_hash<>v_effective_hash and is_current
      and (evidence_text<>p_text or (source_kind=p_source_kind
        and intelligence_observation_context(source_kind,metadata)->'researchTopics'=v_context->'researchTopics'));
  insert into intelligence_observations(company_id,source_key,source_kind,source_url,title,evidence_text,
    content_hash,event_date,observed_at,metadata,sections)
  values(p_company,p_source_key,p_source_kind,p_url,p_title,p_text,v_effective_hash,p_event_date,p_observed_at,
    p_metadata||jsonb_build_object('documentContentHash',p_hash),p_sections)
  on conflict(company_id,source_key,content_hash) do update
    set last_seen_at=now(),is_current=true
  returning id into v_id;

  -- JSONB has stable key ordering. Observation time deliberately does not enter
  -- the key: polling an unchanged discovery updates its last-seen timestamp.
  -- Metadata stays complete, including the original feed URL/title/date, source
  -- identifier, publisher identity, collection mode and candidate-match basis.
  v_discovery_key := encode(sha256(convert_to(jsonb_build_object('sourceKind',p_source_kind,
    'sourceUrl',p_url,'title',p_title,'eventDate',p_event_date,'metadata',p_metadata)::text,'UTF8')),'hex');
  insert into intelligence_observation_discoveries(observation_id,discovery_key,source_kind,source_url,title,event_date,metadata,observed_at)
    values(v_id,v_discovery_key,p_source_kind,p_url,p_title,p_event_date,p_metadata,p_observed_at)
    on conflict(observation_id,discovery_key) do update set last_seen_at=now();

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

revoke all on function public.intelligence_observe(uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.intelligence_observe(uuid,text,text,text,text,text,text,timestamptz,timestamptz,jsonb,jsonb,text) to service_role;
notify pgrst, 'reload schema';
commit;
