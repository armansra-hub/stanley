-- Cached operating-context search across canonical TAM accounts. No model calls,
-- source fetches, qualification grades, or membership mutations.
begin;

create function public.intelligence_supported_topics(p_attributes jsonb,p_text text)
returns text[] language sql immutable set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct item->>'topic'),array[]::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_attributes->'topicEvidence')='array'
    then p_attributes->'topicEvidence' else '[]'::jsonb end) item
  where p_attributes->>'companyRelationship'='direct'
    and case when jsonb_typeof(p_attributes->'companyRelevance')='number'
      then (p_attributes->>'companyRelevance')::numeric between .8 and 1 else false end
    and item->>'topic'=any(array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work'])
    and case when jsonb_typeof(item->'probability')='number'
      then (item->>'probability')::numeric between .8 and 1 else false end
    and case when jsonb_typeof(item->'start')='number' and jsonb_typeof(item->'end')='number' then
      (item->>'start')::numeric>=0 and (item->>'start')::numeric=trunc((item->>'start')::numeric)
      and (item->>'end')::numeric=trunc((item->>'end')::numeric)
      and (item->>'end')::numeric>(item->>'start')::numeric
      -- Stored offsets use JavaScript UTF-16 units. Supplementary Unicode characters
      -- occupy two units; PostgreSQL length alone would incorrectly reject them.
      and (item->>'end')::numeric <= length(p_text)+length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'))
      else false end;
$$;

alter table public.intelligence_observations add column cached_operating_topics text[]
  generated always as (public.intelligence_supported_topics(attributes,evidence_text)) stored;
create index intelligence_cached_operating_topics on public.intelligence_observations
  using gin(cached_operating_topics) where is_current;

create function public.intelligence_topic_search(p_topics text[],p_after uuid default null,p_limit integer default 8)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer; v_topics text[];
begin
  if p_topics is null or cardinality(p_topics)<1 or cardinality(p_topics)>8
    or array_position(p_topics,null) is not null
    or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work']::text[]
    or p_limit is null or p_limit<1 or p_limit>12 then raise exception 'Invalid operating topic query'; end if;
  select array_agg(distinct topic order by topic) into v_topics from unnest(p_topics) topic;
  v_limit:=p_limit;
  if not coalesce((select enabled from intelligence_config where id=1),false) then
    return jsonb_build_object('enabled',false,'topics',v_topics,'accounts','[]'::jsonb,'hasMore',false,'nextCursor',null);
  end if;
  return (
    with eligible as materialized (
      select id,name,domain,subindustry,netsuite_internal_id from companies
      where lists @> array['netsuite_tam']::text[] and status<>'removed_from_tam'
        and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
        and netsuite_internal_id ~ '^[0-9]+$'
    ), observations as not materialized (
      select o.* from intelligence_observations o join eligible c on c.id=o.company_id where o.is_current
    ), matched as (
      select o.company_id from observations o cross join lateral unnest(o.cached_operating_topics) topic
      where o.cached_operating_topics && v_topics and topic=any(v_topics)
      group by o.company_id having count(distinct topic)=cardinality(v_topics)
    ), page as materialized (
      select c.* from eligible c join matched m on m.company_id=c.id
      where p_after is null or c.id>p_after order by c.id limit v_limit+1
    ), shown as materialized (
      select * from page order by id limit v_limit
    ), account_rows as (
      select c.id,jsonb_build_object(
        'companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,'internalId',c.netsuite_internal_id,
        'coverage',(select jsonb_build_object('observations',count(*),'interpreted',count(*) filter(where attributes is not null))
          from observations where company_id=c.id),
        -- Return one most recently captured supporting source per selected topic.
        -- A source supporting multiple topics is sent once. The page is bounded
        -- to 12 accounts x 8 sources, not an unbounded evidence dump.
        'observations',coalesce((select jsonb_agg(jsonb_build_object(
          'id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
          'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'attributes',o.attributes)
          order by o.observed_at desc,o.id)
          from observations o where o.id in (
            select distinct on (topic) supporting.id
            from observations supporting cross join lateral unnest(v_topics) topic
            where supporting.company_id=c.id and topic=any(supporting.cached_operating_topics)
            order by topic,supporting.observed_at desc,supporting.id desc
          )), '[]'::jsonb)
      ) value from shown c
    ) select jsonb_build_object(
      'enabled',true,'topics',v_topics,'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
      'hasMore',(select count(*)>v_limit from page),
      'nextCursor',case when (select count(*)>v_limit from page) then (select id from shown order by id desc limit 1) else null end,
      'coverage',jsonb_build_object(
        'tamAccounts',(select count(*) from eligible),
        'accountsWithTopicEvidence',(select count(distinct company_id) from observations where cardinality(cached_operating_topics)>0),
        'currentObservations',(select count(*) from observations),
        'interpretedObservations',(select count(*) from observations where attributes is not null),
        'matchingAccounts',(select count(*) from matched),
        'asOf',now(),'cacheOnly',true)
    )
  );
end $$;

revoke all on function public.intelligence_supported_topics(jsonb,text) from public,anon,authenticated;
grant execute on function public.intelligence_supported_topics(jsonb,text) to service_role;
revoke all on function public.intelligence_topic_search(text[],uuid,integer) from public,anon,authenticated;
grant execute on function public.intelligence_topic_search(text[],uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
