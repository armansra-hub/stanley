-- Read-only topic query repair. No cache rebuild, thresholds, model calls or source mutations.
-- One compact current-evidence scan serves counts and matching. Full native rows
-- are loaded only by the bounded selected source IDs (at most 12 x 8).
begin;

create or replace function public.intelligence_topic_search(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_topics text[];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]
  or p_mode is null or p_mode not in ('all','any') or p_limit is null or p_limit<1 or p_limit>12 then
   raise exception 'Invalid operating topic query';
 end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  select o.id,o.company_id,o.observed_at,o.cached_operating_topics as topics,o.attributes is not null as interpreted
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded
 ), account_stats as materialized (
  select company_id,count(*) observations,count(*) filter(where interpreted) interpreted
  from observations group by company_id
 ), totals as (
  select coalesce(sum(observations),0) observations,coalesce(sum(interpreted),0) interpreted,
   count(*) filter(where interpreted>0) interpreted_accounts from account_stats
 ), account_topics as materialized (
  select distinct o.company_id,topic from observations o cross join lateral unnest(o.topics) topic
 ), topic_counts as (
  select topic,count(*) accounts from account_topics group by topic
 ), selected_accounts as materialized (
  select company_id,count(*) topic_count from account_topics where topic=any(v_topics) group by company_id
 ), matched as materialized (
  select company_id from selected_accounts where p_mode='any' or topic_count=cardinality(v_topics)
 ), page as materialized (
  select c.* from eligible c join matched m on m.company_id=c.id
  where p_after is null or c.id>p_after order by c.id limit p_limit+1
 ), shown as materialized (
  select * from page order by id limit p_limit
 ), chosen as materialized (
  select distinct on(o.company_id,requested.topic) o.company_id,requested.topic,o.id
  from observations o join shown c on c.id=o.company_id
  cross join lateral unnest(v_topics) requested(topic)
  where requested.topic=any(o.topics)
  order by o.company_id,requested.topic,o.observed_at desc,o.id desc
 ), source_ids as materialized (
  select distinct company_id,id from chosen
 ), evidence as materialized (
  select selected.company_id,jsonb_agg(jsonb_build_object(
   'id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
   'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'attributes',o.attributes)
   order by o.observed_at desc,o.id) observations
  from source_ids selected join intelligence_observations o on o.id=selected.id
  group by selected.company_id
 ), account_rows as (
  select c.id,jsonb_build_object('companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,
   'internalId',c.netsuite_internal_id,'coverage',jsonb_build_object('observations',coalesce(s.observations,0),
   'interpreted',coalesce(s.interpreted,0)),'observations',coalesce(e.observations,'[]'::jsonb)) value
  from shown c left join account_stats s on s.company_id=c.id left join evidence e on e.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]) known(topic)
   left join topic_counts t on t.topic=known.topic),
  'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
  'hasMore',(select count(*)>p_limit from page),
  'nextCursor',case when (select count(*)>p_limit from page) then (select id from shown order by id desc limit 1) else null end,
  'coverage',jsonb_build_object('tamAccounts',(select count(*) from eligible),
   'accountsWithTopicEvidence',(select count(distinct company_id) from account_topics),
   'currentObservations',totals.observations,'interpretedObservations',totals.interpreted,
   'matchingAccounts',(select count(*) from matched),
   'accountsWithNoInterpretedEvidence',(select count(*) from eligible)-totals.interpreted_accounts,
   'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible)-(select count(*) from selected_accounts) else null end,
   'asOf',now(),'cacheOnly',true)) from totals
 );
end $$;
revoke all on function public.intelligence_topic_search(text[],uuid,integer,text) from public,anon,authenticated;
grant execute on function public.intelligence_topic_search(text[],uuid,integer,text) to service_role;

create or replace function public.intelligence_topic_explore(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_topics text[];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]
  or p_mode is null or p_mode not in ('all','any') or p_limit is null or p_limit<1 or p_limit>12 then
   raise exception 'Invalid operating topic query';
 end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  select o.id,o.company_id,o.observed_at,coalesce(o.cached_exploratory_topics,public.intelligence_exploratory_topics(o.attributes,o.evidence_text)) as topics,o.attributes is not null as interpreted
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded
 ), account_stats as materialized (
  select company_id,count(*) observations,count(*) filter(where interpreted) interpreted
  from observations group by company_id
 ), totals as (
  select coalesce(sum(observations),0) observations,coalesce(sum(interpreted),0) interpreted,
   count(*) filter(where interpreted>0) interpreted_accounts from account_stats
 ), account_topics as materialized (
  select distinct o.company_id,topic from observations o cross join lateral unnest(o.topics) topic
 ), topic_counts as (
  select topic,count(*) accounts from account_topics group by topic
 ), selected_accounts as materialized (
  select company_id,count(*) topic_count from account_topics where topic=any(v_topics) group by company_id
 ), matched as materialized (
  select company_id from selected_accounts where p_mode='any' or topic_count=cardinality(v_topics)
 ), page as materialized (
  select c.* from eligible c join matched m on m.company_id=c.id
  where p_after is null or c.id>p_after order by c.id limit p_limit+1
 ), shown as materialized (
  select * from page order by id limit p_limit
 ), chosen as materialized (
  select distinct on(o.company_id,requested.topic) o.company_id,requested.topic,o.id
  from observations o join shown c on c.id=o.company_id
  cross join lateral unnest(v_topics) requested(topic)
  where requested.topic=any(o.topics)
  order by o.company_id,requested.topic,o.observed_at desc,o.id desc
 ), source_ids as materialized (
  select distinct company_id,id from chosen
 ), evidence as materialized (
  select selected.company_id,jsonb_agg(jsonb_build_object(
   'id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
   'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'attributes',o.attributes)
   order by o.observed_at desc,o.id) observations
  from source_ids selected join intelligence_observations o on o.id=selected.id
  group by selected.company_id
 ), account_rows as (
  select c.id,jsonb_build_object('companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,
   'internalId',c.netsuite_internal_id,'coverage',jsonb_build_object('observations',coalesce(s.observations,0),
   'interpreted',coalesce(s.interpreted,0)),'observations',coalesce(e.observations,'[]'::jsonb)) value
  from shown c left join account_stats s on s.company_id=c.id left join evidence e on e.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,'visibility','explore',
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]) known(topic)
   left join topic_counts t on t.topic=known.topic),
  'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
  'hasMore',(select count(*)>p_limit from page),
  'nextCursor',case when (select count(*)>p_limit from page) then (select id from shown order by id desc limit 1) else null end,
  'coverage',jsonb_build_object('tamAccounts',(select count(*) from eligible),
   'accountsWithTopicEvidence',(select count(distinct company_id) from account_topics),
   'currentObservations',totals.observations,'interpretedObservations',totals.interpreted,
   'matchingAccounts',(select count(*) from matched),
   'accountsWithNoInterpretedEvidence',(select count(*) from eligible)-totals.interpreted_accounts,
   'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible)-(select count(*) from selected_accounts) else null end,
   'asOf',now(),'cacheOnly',true)) from totals
 );
end $$;
revoke all on function public.intelligence_topic_explore(text[],uuid,integer,text) from public,anon,authenticated;
grant execute on function public.intelligence_topic_explore(text[],uuid,integer,text) to service_role;

notify pgrst,'reload schema';
commit;
