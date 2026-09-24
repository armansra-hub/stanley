-- Read-only union of legacy source topics and versioned, cross-source native
-- catalog decisions. No paid calls, queue admission, grading or activation.
begin;
create or replace function public.intelligence_catalog_topic_search(
 p_topics text[], p_catalog_version text, p_facet_versions jsonb, p_after uuid default null,
 p_limit integer default 8, p_mode text default 'all',
 p_show_hidden boolean default false, p_visibility text default 'supported',p_combinations jsonb default null)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off as $$
declare v_topics text[];
 v_legacy text[] := array['multi_entity','project_billing','recurring_revenue','inventory','multi_location',
 'systems_project','acquisition_integration','government_work','close_reporting','financial_controls',
 'cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability',
 'media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work','non_asset_based_3pl'];
 v_facets text[] := array['rr_c01','rr_c02','rr_c03','rr_c04','rr_c05','rr_c06','rr_c07','rr_c08','rr_c09','rr_c10','rr_c11','rr_c12',
 'rr_t01','rr_t02','rr_t03','rr_t04','rr_t05','rr_f01','rr_f02','rr_f03','rr_i01','rr_i02','rr_i03','rr_i04',
 'rr_p01','rr_p02','rr_p03','rr_m01','rr_m02','rr_m03','rr_m04','rr_h01','rr_h02','rr_h03',
 'rr_s01','rr_s02','rr_s03','rr_r01','rr_r02','rr_r03','rr_n01','rr_n02','rr_o01','rr_o02','rr_o03','rr_o04','rr_o05'];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ (v_legacy || v_facets)
  or p_catalog_version is null or length(p_catalog_version)>120 or p_facet_versions is null or jsonb_typeof(p_facet_versions)<>'object'
  or p_mode is null or p_mode not in ('all','any')
  or p_visibility is null or p_visibility not in ('supported','explore')
  or p_show_hidden is null or p_limit is null or p_limit<1 or p_limit>12 then
  raise exception 'Invalid operating catalog query';
 end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 if p_combinations is not null then
  if jsonb_typeof(p_combinations)<>'array' or jsonb_array_length(p_combinations) not between 1 and 16 then raise exception 'Invalid recipe'; end if;
  if exists(select 1 from jsonb_array_elements(p_combinations) branch where jsonb_typeof(branch)<>'array') then raise exception 'Invalid recipe'; end if;
  if exists(select 1 from jsonb_array_elements(p_combinations) branch where jsonb_array_length(branch) not between 1 and 8
   or exists(select 1 from jsonb_array_elements_text(branch) topic where not topic=any(v_topics))) then raise exception 'Invalid recipe'; end if;
 end if;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id,status from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and (p_show_hidden or (coalesce(status,'') not in ('reviewed','dismissed') and coalesce(status,'') not like 'exported%'))
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  select o.id,o.company_id,o.observed_at,
   case when p_visibility='supported' then o.cached_operating_topics
    else coalesce(o.cached_exploratory_topics,intelligence_exploratory_topics(o.attributes,o.evidence_text)) end as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded
 ), catalog as materialized (
  select f.company_id,f.facet_id
  from intelligence_catalog_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_accounts a on a.company_id=f.company_id
   and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered' and f.decision='supported'
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.facet_id=any(v_facets) and jsonb_array_length(coalesce(cs.citations,f.citations))>0
   -- These are provenance checks, never another model judging Jev's decision.
   and not exists(select 1 from jsonb_array_elements(coalesce(cs.citations,f.citations)) cite
    where not exists(select 1 from intelligence_observations o
     where o.id=case when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end and o.company_id=f.company_id
      and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
 ), current_counts as materialized (
  select o.company_id,count(*) observations from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded group by o.company_id
 ), interpreted_counts as materialized (
  select o.company_id,count(*) interpreted from intelligence_observations o join eligible c on c.id=o.company_id
  where o.is_current and not o.feedback_excluded and o.attributes is not null group by o.company_id
 ), account_stats as materialized (
  select c.company_id,c.observations,coalesce(i.interpreted,0) interpreted
  from current_counts c left join interpreted_counts i on i.company_id=c.company_id
 ), totals as (
  select coalesce(sum(observations),0) observations,coalesce(sum(interpreted),0) interpreted,
   count(*) filter(where interpreted>0) interpreted_accounts from account_stats
 ), account_topics as materialized (
  select distinct o.company_id,topic from observations o cross join lateral unnest(o.topics) topic where topic=any(v_legacy)
  union select company_id,facet_id from catalog
 ), topic_counts as (select topic,count(*) accounts from account_topics group by topic),
 selected_accounts as materialized (
  select company_id,count(*) topic_count from account_topics where topic=any(v_topics) group by company_id
 ), matched as materialized (
  select s.company_id from selected_accounts s
  where case when p_combinations is null then p_mode='any' or topic_count=cardinality(v_topics)
   else exists(select 1 from jsonb_array_elements(p_combinations) branch
    where not exists(select 1 from jsonb_array_elements_text(branch) required_topic
     where not exists(select 1 from account_topics a where a.company_id=s.company_id and a.topic=required_topic))) end
 ), page as materialized (
  select c.* from eligible c join matched m on m.company_id=c.id
  where p_after is null or c.id>p_after order by c.id limit p_limit+1
 ), shown as materialized (select * from page order by id limit p_limit),
 chosen as materialized (
  select distinct on(o.company_id,requested.topic) o.company_id,requested.topic,o.id
  from observations o join shown c on c.id=o.company_id cross join lateral unnest(v_topics) requested(topic)
  where requested.topic=any(o.topics)
  order by o.company_id,requested.topic,o.observed_at desc,o.id desc
 ), facet_rows as materialized (
  select f.company_id,f.facet_id,f.catalog_version,f.status,f.decision,f.probability,f.native_result,
   coalesce(cs.citations,f.citations) citations from intelligence_catalog_facets f
  join catalog valid on valid.company_id=f.company_id and valid.facet_id=f.facet_id
  join shown c on c.id=f.company_id
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where f.facet_id=any(v_topics)
 ), source_ids as materialized (
  select distinct company_id,id::text id from chosen
  union select f.company_id,cite->>'observationId' from facet_rows f cross join lateral jsonb_array_elements(f.citations) cite
 ), evidence as materialized (
  -- Load wide source text once per displayed account/source, never once per facet.
  -- UTF-16 receipt offsets are applied in TypeScript, preserving supplementary characters.
  select selected.company_id,jsonb_agg(jsonb_build_object(
   'id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
   'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'content_hash',o.content_hash,
   'attributes',case when exists(select 1 from chosen ch where ch.id=o.id) then o.attributes else null end)
   order by o.observed_at desc,o.id) observations
  from source_ids selected join intelligence_observations o on o.id=selected.id::uuid and o.company_id=selected.company_id
  group by selected.company_id
 ), facet_evidence as (
  select company_id,jsonb_agg(jsonb_build_object('id',facet_id,'catalogVersion',catalog_version,'status',status,
   'decision',decision,'probability',probability,'nativeResult',native_result,'citations',citations) order by facet_id) facets
  from facet_rows group by company_id
 ), account_rows as (
  select c.id,jsonb_build_object('companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,
   'internalId',c.netsuite_internal_id,'status',c.status,'coverage',jsonb_build_object('observations',coalesce(s.observations,0),
   'interpreted',coalesce(s.interpreted,0)),'observations',coalesce(e.observations,'[]'::jsonb),
   'catalogFacets',coalesce(f.facets,'[]'::jsonb)) value
  from shown c left join account_stats s on s.company_id=c.id left join evidence e on e.company_id=c.id
  left join facet_evidence f on f.company_id=c.id
 ), version_counts as (
  select f.company_id,count(*) answered from intelligence_catalog_facets f join intelligence_catalog_accounts a on a.company_id=f.company_id
  where f.catalog_version=p_catalog_version and a.catalog_version=p_catalog_version and f.evidence_key=a.evidence_key
   and f.facet_version=p_facet_versions->>f.facet_id and f.status='answered' group by f.company_id
 ), catalog_stats as (
  select count(*) filter(where a.status='complete' and v.answered=47) complete,
   count(*) filter(where coalesce(v.answered,0)>0 and not(a.status='complete' and v.answered=47)) partial,
   count(*) filter(where a.status='blocked') blocked,
   count(*) filter(where coalesce(v.answered,0)=0) pending
  from eligible c left join intelligence_catalog_accounts a on a.company_id=c.id and a.catalog_version=p_catalog_version
  left join version_counts v on v.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,'showHidden',p_show_hidden,'visibility',p_visibility,'combinations',p_combinations,
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(v_legacy||v_facets) known(topic)
   left join topic_counts t on t.topic=known.topic),
  'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
  'hasMore',(select count(*)>p_limit from page),
  'nextCursor',case when (select count(*)>p_limit from page) then (select id from shown order by id desc limit 1) else null end,
  'catalogCoverage',jsonb_build_object('version',p_catalog_version,'total',(select count(*) from eligible),
   'publicFacets',47,'contextOnlyFacets',0,'complete',cs.complete,'partial',cs.partial,'blocked',cs.blocked,'pending',cs.pending),
  'coverage',jsonb_build_object('tamAccounts',(select count(*) from eligible),
   'accountsWithTopicEvidence',(select count(distinct company_id) from account_topics),
   'currentObservations',totals.observations,'interpretedObservations',totals.interpreted,
   'matchingAccounts',(select count(*) from matched),
   'accountsWithNoInterpretedEvidence',(select count(*) from eligible)-totals.interpreted_accounts,
   'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible)-(select count(*) from selected_accounts) else null end,
   'asOf',now(),'cacheOnly',true)) from totals cross join catalog_stats cs
 );
end $$;
revoke all on function public.intelligence_catalog_topic_search(text[],text,jsonb,uuid,integer,text,boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_catalog_topic_search(text[],text,jsonb,uuid,integer,text,boolean,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
