-- Add the future non-asset-based 3PL question to cached Operating Matches and
-- apply the existing company dismissal/review/export visibility to both reads.
-- This changes read functions only: no evidence rewrite, cache backfill, job
-- enqueue, model call, worker activation, or grading/membership change.
-- The existing exploratory cache accepts native topic keys without an allowlist.
begin;

create or replace function public.intelligence_supported_topics(p_attributes jsonb,p_text text)
returns text[] language sql immutable set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct item->>'topic'),array[]::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_attributes->'topicEvidence')='array'
    then p_attributes->'topicEvidence' else '[]'::jsonb end) item
  cross join lateral (select case when item ? 'companyRelationship' or item ? 'companyRelevance'
    then item else p_attributes end as attribution) a
  where a.attribution->>'companyRelationship'='direct'
    and case when jsonb_typeof(a.attribution->'companyRelevance')='number'
      then (a.attribution->>'companyRelevance')::numeric between .8 and 1 else false end
    and item->>'topic'=any(array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work','project_delivery',
      'project_financials','unbilled_work','close_reporting','financial_controls','cash_working_capital',
      'finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights',
      'fleet_costs','investor_reporting','non_asset_based_3pl'])
    and case when jsonb_typeof(item->'probability')='number'
      then (item->>'probability')::numeric between .8 and 1 else false end
    and case when jsonb_typeof(item->'start')='number' and jsonb_typeof(item->'end')='number' then
      (item->>'start')::numeric>=0 and (item->>'start')::numeric=trunc((item->>'start')::numeric)
      and (item->>'end')::numeric=trunc((item->>'end')::numeric)
      and (item->>'end')::numeric>(item->>'start')::numeric
      and (item->>'end')::numeric <= length(p_text)+length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'))
      else false end;
$$;

-- Remove the old overload so PostgREST can resolve omitted default arguments
-- unambiguously. Existing four-argument callers still use the new default.
drop function public.intelligence_topic_search(text[],uuid,integer,text);
drop function public.intelligence_topic_explore(text[],uuid,integer,text);

create or replace function public.intelligence_topic_search(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all',p_show_hidden boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp set jit=off as $$
declare v_topics text[];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work','non_asset_based_3pl']::text[]
  or p_show_hidden is null or p_mode is null or p_mode not in ('all','any') or p_limit is null or p_limit<1 or p_limit>12 then
   raise exception 'Invalid operating topic query';
 end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id,status from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and (p_show_hidden or (coalesce(status,'') not in ('reviewed','dismissed') and coalesce(status,'') not like 'exported%'))
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  select o.id,o.company_id,o.observed_at,o.cached_operating_topics as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded
 ), current_counts as materialized (
  -- Existing partial indexes already separate all current rows from rows
  -- with interpreted answers. Do not touch raw attributes to count them.
  select o.company_id,count(*) observations
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded group by o.company_id
 ), interpreted_counts as materialized (
  select o.company_id,count(*) interpreted
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.attributes is not null group by o.company_id
 ), account_stats as materialized (
  select c.company_id,c.observations,coalesce(i.interpreted,0) interpreted
  from current_counts c left join interpreted_counts i on i.company_id=c.company_id
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
   'internalId',c.netsuite_internal_id,'status',c.status,'coverage',jsonb_build_object('observations',coalesce(s.observations,0),
   'interpreted',coalesce(s.interpreted,0)),'observations',coalesce(e.observations,'[]'::jsonb)) value
  from shown c left join account_stats s on s.company_id=c.id left join evidence e on e.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,'showHidden',p_show_hidden,
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work','non_asset_based_3pl']::text[]) known(topic)
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
revoke all on function public.intelligence_topic_search(text[],uuid,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.intelligence_topic_search(text[],uuid,integer,text,boolean) to service_role;

create or replace function public.intelligence_topic_explore(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all',p_show_hidden boolean default false)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp set jit=off as $$
declare v_topics text[];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work','non_asset_based_3pl']::text[]
  or p_show_hidden is null or p_mode is null or p_mode not in ('all','any') or p_limit is null or p_limit<1 or p_limit>12 then
   raise exception 'Invalid operating topic query';
 end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id,status from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and (p_show_hidden or (coalesce(status,'') not in ('reviewed','dismissed') and coalesce(status,'') not like 'exported%'))
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  -- This branch references compact indexed fields only. COALESCE with the
  -- native fallback would still require the wide heap even when every cache
  -- is populated, so retain legacy NULL-cache handling in its own branch.
  select o.id,o.company_id,o.observed_at,o.cached_exploratory_topics as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.cached_exploratory_topics is not null
  union all
  select o.id,o.company_id,o.observed_at,public.intelligence_exploratory_topics(o.attributes,o.evidence_text) as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.cached_exploratory_topics is null
 ), current_counts as materialized (
  -- Existing partial indexes already separate all current rows from rows
  -- with interpreted answers. Do not touch raw attributes to count them.
  select o.company_id,count(*) observations
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded group by o.company_id
 ), interpreted_counts as materialized (
  select o.company_id,count(*) interpreted
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.attributes is not null group by o.company_id
 ), account_stats as materialized (
  select c.company_id,c.observations,coalesce(i.interpreted,0) interpreted
  from current_counts c left join interpreted_counts i on i.company_id=c.company_id
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
   'internalId',c.netsuite_internal_id,'status',c.status,'coverage',jsonb_build_object('observations',coalesce(s.observations,0),
   'interpreted',coalesce(s.interpreted,0)),'observations',coalesce(e.observations,'[]'::jsonb)) value
  from shown c left join account_stats s on s.company_id=c.id left join evidence e on e.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,'showHidden',p_show_hidden,'visibility','explore',
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work','non_asset_based_3pl']::text[]) known(topic)
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
revoke all on function public.intelligence_topic_explore(text[],uuid,integer,text,boolean) from public,anon,authenticated;
grant execute on function public.intelligence_topic_explore(text[],uuid,integer,text,boolean) to service_role;

notify pgrst,'reload schema';
commit;
