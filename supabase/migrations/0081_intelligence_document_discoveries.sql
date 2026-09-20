begin;

-- One interpreted document can be rediscovered by news, feeds, site crawling and
-- directed research. Keep every distinct capture's original provenance without
-- creating another paid interpretation. Existing observations remain untouched.
create table public.intelligence_observation_discoveries (
  observation_id uuid not null references public.intelligence_observations(id),
  discovery_key text not null check (length(discovery_key)=64),
  source_kind text not null,
  source_url text not null,
  title text not null,
  event_date timestamptz,
  metadata jsonb not null,
  observed_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  primary key(observation_id,discovery_key)
);
alter table public.intelligence_observation_discoveries enable row level security;
revoke all on public.intelligence_observation_discoveries from anon, authenticated;
grant all on public.intelligence_observation_discoveries to service_role;

-- These fields affect the actual question pack, date interpretation or reusable
-- account identity. Discovery/transport labels and collection timestamps do not.
-- Compute legacy-row context from its existing metadata so equivalent historical
-- captures keep their paid answers without any global rehash or backfill.
create function public.intelligence_observation_context(p_source_kind text,p_metadata jsonb)
returns jsonb language sql immutable set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'sourceKind',p_source_kind,
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
