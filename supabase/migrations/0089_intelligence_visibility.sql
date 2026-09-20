-- Read-only exploration and saved-output diagnostics. Publishing defaults do not change.
begin;
create function public.intelligence_native_topic_references(p_attributes jsonb)
returns setof jsonb language sql immutable security definer set search_path=public,pg_temp as $$
 select value from jsonb_array_elements(case when jsonb_typeof(p_attributes->'topicEvidence')='array' then p_attributes->'topicEvidence' else '[]' end)
 union all
 select jsonb_build_object('topic',c.key,'probability',c.value,'companyRelationship',p.value#>'{attributes,companyRelationship}',
  'companyRelevance',p.value#>'{attributes,companyRelevance}','start',p.value->'start','end',p.value->'end')
 from jsonb_array_elements(case when jsonb_typeof(p_attributes->'packetFindings')='array' then p_attributes->'packetFindings' else '[]' end) p
 cross join lateral jsonb_each(case when jsonb_typeof(p.value->'criteria')='object' then p.value->'criteria' else '{}' end) c
$$;
create function public.intelligence_topic_explore(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer; v_topics text[];
begin
  if p_topics is null or cardinality(p_topics)>8
    or array_position(p_topics,null) is not null
    or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work','close_reporting',
      'financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs',
      'client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]
    or p_mode is null or p_mode not in ('all','any')
    or p_limit is null or p_limit<1 or p_limit>12 then raise exception 'Invalid operating topic query'; end if;
  select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
  v_limit:=p_limit;
  return (
    with eligible as materialized (
      select id,name,domain,subindustry,netsuite_internal_id from companies
      where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
        and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
        and netsuite_internal_id ~ '^[0-9]+$'
    ), observations as not materialized (
select o.*,array(select distinct r->>'topic' from intelligence_native_topic_references(o.attributes) r
       cross join lateral(select case when r ? 'companyRelationship' or r ? 'companyRelevance' then r else o.attributes end value) attribution
       where attribution.value->>'companyRelationship'='direct'
        and case when jsonb_typeof(r->'probability')='number' then (r->>'probability')::numeric between .5 and 1 else false end
        and case when jsonb_typeof(attribution.value->'companyRelevance')='number'
         then (attribution.value->>'companyRelevance')::numeric between .5 and 1 else false end
        and case when jsonb_typeof(r->'start')='number' and jsonb_typeof(r->'end')='number'
         then (r->>'start')::numeric>=0 and (r->>'start')::numeric=trunc((r->>'start')::numeric)
          and (r->>'end')::numeric=trunc((r->>'end')::numeric) and (r->>'end')::numeric>(r->>'start')::numeric
          and (r->>'end')::numeric<=length(o.evidence_text)+length(regexp_replace(o.evidence_text,U&'[^\+010000-\+10FFFF]','','g')) else false end
      ) exploration_topics
      from intelligence_observations o join eligible c on c.id=o.company_id where o.is_current and not o.feedback_excluded
    ), matched as (
      select o.company_id from observations o cross join lateral unnest(o.exploration_topics) topic
      where o.exploration_topics && v_topics and topic=any(v_topics)
      group by o.company_id having p_mode='any' or count(distinct topic)=cardinality(v_topics)
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
            where supporting.company_id=c.id and topic=any(supporting.exploration_topics)
            order by topic,supporting.observed_at desc,supporting.id desc
          )), '[]'::jsonb)
      ) value from shown c
    ) select jsonb_build_object(
      'enabled',true,'topics',v_topics,'mode',p_mode,'visibility','explore',
      'topicCounts',coalesce((select jsonb_object_agg(topic,accounts) from (
        select known.topic,count(distinct o.company_id) accounts from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','project_delivery','project_financials','unbilled_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting']::text[]) known(topic)
        left join observations o on known.topic=any(o.exploration_topics) group by known.topic
      ) counts),'{}'::jsonb),'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
      'hasMore',(select count(*)>v_limit from page),
      'nextCursor',case when (select count(*)>v_limit from page) then (select id from shown order by id desc limit 1) else null end,
      'coverage',jsonb_build_object(
        'tamAccounts',(select count(*) from eligible),
        'accountsWithTopicEvidence',(select count(distinct company_id) from observations where cardinality(exploration_topics)>0),
        'currentObservations',(select count(*) from observations),
        'interpretedObservations',(select count(*) from observations where attributes is not null),
        'matchingAccounts',(select count(*) from matched),
        'accountsWithNoInterpretedEvidence',(select count(*) from eligible) - (select count(distinct company_id) from observations where attributes is not null),
        'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible) - (select count(distinct company_id) from observations where exploration_topics && v_topics) else null end,
        'asOf',now(),'cacheOnly',true)
    )
  );
end $$;




create function public.intelligence_visibility_sample(p_after uuid default null,p_limit integer default 200)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 with eligible as materialized(select id,name from companies where lists @> array['netsuite_tam']::text[]
   and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'),
 page as materialized(select o.id,o.company_id,c.name,o.title,o.source_url,o.event_date,o.attributes from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.attributes is not null and (p_after is null or o.id>p_after)
  order by o.id limit greatest(1,least(200,p_limit))+1),
 shown as materialized(select * from page order by id limit greatest(1,least(200,p_limit)))
 select jsonb_build_object('asOf',now(),'hasMore',(select count(*)>greatest(1,least(200,p_limit)) from page),
 'nextCursor',case when (select count(*)>greatest(1,least(200,p_limit)) from page) then (select id from shown order by id desc limit 1) else null end,
 'observations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'companyId',o.company_id,'companyName',o.name,'title',o.title,'url',o.source_url,'eventDate',o.event_date,
  'packets',(select jsonb_agg(jsonb_build_object('attributes',coalesce(p->'attributes',p),'criteria',coalesce(p->'criteria','{}'),
   'questionVersion',p->>'questionVersion','publication',p->'publication'))
   from jsonb_array_elements(case when jsonb_typeof(o.attributes->'packetFindings')='array' and jsonb_array_length(o.attributes->'packetFindings')>0 then o.attributes->'packetFindings' else jsonb_build_array(o.attributes) end) p)) order by o.id) from shown o),'[]'::jsonb))
$$;
revoke all on function public.intelligence_native_topic_references(jsonb),public.intelligence_topic_explore(text[],uuid,integer,text),public.intelligence_visibility_sample(uuid,integer) from public,anon,authenticated;
grant execute on function public.intelligence_native_topic_references(jsonb),public.intelligence_topic_explore(text[],uuid,integer,text),public.intelligence_visibility_sample(uuid,integer) to service_role;
notify pgrst,'reload schema';
commit;
