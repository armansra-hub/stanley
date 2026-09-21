begin;

-- Both ordinary collection and directed research may reuse an already-paid
-- answer that covers their exact questions. Ordinary collectors now supply the
-- actual worker criterion IDs and the current company subindustry; absent or
-- stale company context opts out. Preserve the existing directed-research path.
-- No observations, completed jobs, rubrics or paid answers are rewritten.
-- Cross-topic reuse must cover every requested criterion and the whole retained
-- document; opted-in captures also require the exact configured model. Exact
-- legacy captures keep their existing rubric without an involuntary upgrade.
-- Native negative/unknown answers are reusable too.
-- Only an actual company identity/context edit advances this epoch. Default zero
-- is computed for legacy metadata too, preserving every unchanged paid answer.
create or replace function public.intelligence_observation_context(p_source_kind text,p_metadata jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'sourceKind',p_source_kind,
    'accountContextRevision',case when jsonb_typeof(p_metadata->'accountContextRevision')='number'
      and p_metadata->>'accountContextRevision' ~ '^[0-9]+$'
      then p_metadata->'accountContextRevision' else '0'::jsonb end,
    'researchTopics',case when jsonb_typeof(p_metadata->'researchTopics')='array' then p_metadata->'researchTopics' else '[]'::jsonb end,
    'sourceDates',case when jsonb_typeof(p_metadata->'sourceDates')='array' then p_metadata->'sourceDates' else '[]'::jsonb end,
    'eventDateBasis',coalesce(p_metadata->>'eventDateBasis','unknown'),
    'evidenceKind',p_metadata->'evidenceKind',
    'companyIdentity',p_metadata->'companyIdentity',
    'publisherIdentity',p_metadata->'publisherIdentity',
    'textTruncated',coalesce(p_metadata->'textTruncated'='true'::jsonb,false) or coalesce(p_metadata->'sourceTruncated'='true'::jsonb,false)
  );
$$;
revoke all on function public.intelligence_observation_context(text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_observation_context(text,jsonb) to service_role;

-- Reuse proves question availability, never judges native answers. Malformed,
-- missing or different-model packets cannot satisfy an opted-in capture.
create function public.intelligence_capture_answers_cover(p_attributes jsonb,p_metadata jsonb)
returns boolean language sql immutable set search_path=public,pg_temp as $$
  select intelligence_packet_criteria_cover(p_attributes,p_metadata->'researchCriteria',p_metadata->'retainedCharacters')
    and p_metadata->>'researchCriteriaModel' ~ '^jev-[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$'
    and not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_attributes->'packetFindings')='array'
      then p_attributes->'packetFindings' else '[]'::jsonb end) packet
      where packet->>'model' is distinct from p_metadata->>'researchCriteriaModel');
$$;
revoke all on function public.intelligence_capture_answers_cover(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_capture_answers_cover(jsonb,jsonb) to service_role;

create or replace function public.intelligence_observe(p_company uuid, p_source_key text, p_source_kind text,
  p_url text, p_title text, p_text text, p_hash text, p_event_date timestamptz,
  p_observed_at timestamptz, p_metadata jsonb, p_sections jsonb, p_version text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_id uuid; v_queued boolean := false; v_discovery_key text; v_context jsonb; v_effective_hash text; v_subindustry text; v_context_revision bigint; v_requested_contract jsonb;
begin
  if not coalesce((select enabled from intelligence_config where id=1),false) then
    return jsonb_build_object('disabled',true);
  end if;
  select subindustry into v_subindustry from companies where id=p_company and status <> 'removed_from_tam';
  if not found then
    raise exception 'Account is not eligible for intelligence';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_company::text || p_source_key,0));
  select context_revision into v_context_revision from intelligence_directed_research_jobs where company_id=p_company;
  -- The durable server epoch wins over collector metadata, including a stale
  -- capture that began before a company edit. Existing epoch-zero rows need no
  -- rewrite and retain their original content hashes.
  p_metadata:=coalesce(p_metadata,'{}'::jsonb)-'accountContextRevision';
  if coalesce(v_context_revision,0)>0 then
    p_metadata:=p_metadata||jsonb_build_object('accountContextRevision',v_context_revision);
  end if;
  v_context := intelligence_observation_context(p_source_kind,p_metadata);
  if p_metadata->>'researchCriteriaBasis'='worker-operating-criteria-v1' then
    -- This salt is used only after no compatible legacy/native answer exists.
    -- Reordered identical criterion sets must not create a different version.
    v_requested_contract:=jsonb_build_object('model',p_metadata->'researchCriteriaModel',
      'criteria',case when jsonb_typeof(p_metadata->'researchCriteria')='array' then (
        select jsonb_agg(value order by value) from (select distinct value from jsonb_array_elements(p_metadata->'researchCriteria')) criteria
      ) else p_metadata->'researchCriteria' end);
  end if;
  select o.content_hash into v_effective_hash from intelligence_observations o
    where o.company_id=p_company and o.source_key=p_source_key
      and (o.content_hash=p_hash or o.metadata->>'documentContentHash'=p_hash)
      and intelligence_observation_context(o.source_kind,o.metadata)=v_context
      and (v_requested_contract is null
        -- Adding criterion bookkeeping is not a request to upgrade a completed
        -- legacy rubric. Exact legacy context retains its original answer and
        -- job, without asserting it answers any newly requested criteria. Only
        -- a different source/topic/context stream uses the strict subset gate.
        or o.metadata->>'researchCriteriaBasis' is distinct from 'worker-operating-criteria-v1' or (
        p_metadata->'researchCriteriaSubindustry'=coalesce(to_jsonb(v_subindustry),'null'::jsonb)
        and (intelligence_capture_answers_cover(o.attributes,p_metadata)
          -- An opted-in pending job keeps its exact saved request when its
          -- requested model and questions still match this capture.
          or (o.attributes is null and not exists(select 1 from intelligence_jobs j where j.observation_id=o.id and j.kind='interpret' and j.status='complete')
            and o.metadata->'researchCriteriaModel'=p_metadata->'researchCriteriaModel'
            and o.metadata->'researchCriteria'=p_metadata->'researchCriteria'))))
    order by observed_at desc,id desc limit 1;
  -- A directed pass can narrow/reorder its research gaps after other sources
  -- answer them. Reuse a finished native answer only when every packet already
  -- contains every criterion this exact pass would ask. Source text, dates,
  -- identity, kind and all other interpretation context must still match.
  if v_effective_hash is null and jsonb_typeof(p_metadata->'researchCriteria')='array'
    and (p_metadata->>'researchCriteriaBasis' is distinct from 'worker-operating-criteria-v1'
      or (p_metadata->'researchCriteriaSubindustry'=coalesce(to_jsonb(v_subindustry),'null'::jsonb)
        and p_metadata->>'researchCriteriaModel' ~ '^jev-[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$')) then
    select o.content_hash into v_effective_hash from intelligence_observations o
      where o.company_id=p_company and o.source_key=p_source_key and o.is_current and not o.feedback_excluded
        and (o.content_hash=p_hash or o.metadata->>'documentContentHash'=p_hash)
        and o.evidence_text=p_text and o.source_url=p_url and o.title=left(p_title,500)
        and o.event_date is not distinct from p_event_date
        and (intelligence_observation_context(o.source_kind,o.metadata)-'researchTopics')=(v_context-'researchTopics')
        and exists(select 1 from intelligence_jobs j where j.observation_id=o.id and j.kind='interpret' and j.status='complete')
        and intelligence_packet_criteria_cover(o.attributes,p_metadata->'researchCriteria',p_metadata->'retainedCharacters')
        and (p_metadata->>'researchCriteriaBasis' is distinct from 'worker-operating-criteria-v1'
          or not exists(select 1 from jsonb_array_elements(case when jsonb_typeof(o.attributes->'packetFindings')='array'
            then o.attributes->'packetFindings' else '[]'::jsonb end) packet
            where packet->>'model' is distinct from p_metadata->>'researchCriteriaModel'))
      order by o.observed_at desc,o.id desc limit 1;
  end if;
  if v_effective_hash is null then
    -- Leave ordinary legacy identities alone. A new material context gets a
    -- separate answer only when the existing base identity is incompatible.
    v_effective_hash := case when exists(select 1 from intelligence_observations
      where company_id=p_company and source_key=p_source_key and content_hash=p_hash)
      then encode(sha256(convert_to(p_hash || ':' || v_context::text || case when v_requested_contract is null then '' else ':'||v_requested_contract::text end,'UTF8')),'hex') else p_hash end;
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
