-- Read-only selected-dictionary search. Exact native receipts and immutable legacy
-- history remain readable; this migration neither admits work nor changes TAM.
begin;
create or replace function public.intelligence_catalog_validate_read(p_version text,p_versions jsonb)
returns void language plpgsql stable security definer set search_path=public,pg_temp as $$
declare expected jsonb;
begin
 if p_version is null or p_versions is null or jsonb_typeof(p_versions)<>'object' then raise exception 'Invalid catalog read'; end if;
 if exists(select 1 from intelligence_catalog_dictionaries where version=p_version and status='approved') then
  select jsonb_object_agg(facet_id,facet_version) into expected from intelligence_catalog_dictionary_facets where catalog_version=p_version;
  if expected is null or expected<>p_versions then raise exception 'Catalog read version mismatch'; end if;
 elsif not exists(select 1 from intelligence_catalog_legacy_versions where version=p_version)
  or exists(select 1 from jsonb_object_keys(p_versions) id where not exists(select 1 from intelligence_catalog_expected_facets(p_version) e where e.facet_id=id))
  or (select count(*) from jsonb_object_keys(p_versions))<>(select count(*) from intelligence_catalog_expected_facets(p_version)) then
  raise exception 'Unregistered catalog read';
 end if;
end $$;
revoke all on function public.intelligence_catalog_validate_read(text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_catalog_validate_read(text,jsonb) to service_role;

create or replace function public.intelligence_customer_match_candidates(
 p_catalog_version text,p_facet_versions jsonb,p_show_hidden boolean default false)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off set enable_nestloop=off set statement_timeout='18000ms' as $$
begin

 perform intelligence_catalog_validate_read(p_catalog_version,p_facet_versions);
 if p_catalog_version is null or length(p_catalog_version)>120 or p_facet_versions is null
  or jsonb_typeof(p_facet_versions)<>'object' or p_show_hidden is null then raise exception 'Invalid customer match query'; end if;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id,status,description,ns_industry,record_dead from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and (p_show_hidden or (coalesce(status,'') not in ('reviewed','dismissed') and coalesce(status,'') not like 'exported%'))
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), facets as materialized (
  select f.company_id,f.facet_id,f.decision,f.evidence_key,f.citation_set_key
  from intelligence_catalog_read_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_read_accounts a on a.company_id=f.company_id
   and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered'
   and f.decision in ('supported','not_supported','conflicting')
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.native_result->'answer'->>'type'='choice'
   and f.native_result->'answer'->>'choice'=f.decision
 ), shared_set_ids as materialized (
  -- Deduplicate small identities before reading wide citation JSON. Many
  -- facets intentionally share one source set; sort that identity only once.
  select distinct company_id,evidence_key,citation_set_key from facets where citation_set_key is not null
 ), shared_sets as materialized (
  select f.company_id,f.evidence_key,cs.citation_set_key,cs.citations
  from shared_set_ids f join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
 ), valid_sets as materialized (
  select s.company_id,s.evidence_key,s.citation_set_key from shared_sets s
  where jsonb_array_length(s.citations)>0 and not exists(
   select 1 from jsonb_array_elements(s.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=s.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
 ), inline_ids as materialized (
  -- Shared-source facets need only the compact proof identity. Fetch an inline
  -- body only when no matching shared set exists, exactly as the prior fallback.
  select f.* from facets f left join shared_sets s
   on s.citation_set_key=f.citation_set_key and s.company_id=f.company_id and s.evidence_key=f.evidence_key
  where s.citation_set_key is null
 ), valid_facets as materialized (
  select f.company_id,f.facet_id,f.decision from facets f join valid_sets s
   on s.citation_set_key=f.citation_set_key and s.company_id=f.company_id and s.evidence_key=f.evidence_key
  union all
  select f.company_id,f.facet_id,f.decision from inline_ids f
  join intelligence_catalog_read_facets original on original.company_id=f.company_id and original.facet_id=f.facet_id
   and original.catalog_version=p_catalog_version and original.evidence_key=f.evidence_key and original.facet_version=p_facet_versions->>original.facet_id
  where jsonb_array_length(original.citations)>0 and not exists(
   select 1 from jsonb_array_elements(original.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=f.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))

  union all
  select f.company_id,f.facet_id,f.decision
  from intelligence_catalog_read_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_read_accounts a on a.company_id=f.company_id and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered' and f.decision='insufficient_evidence'
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.native_result->'answer'->>'type'='choice' and f.native_result->'answer'->>'choice' in ('unknown','insufficient_evidence')

 ), decisions as (
  select company_id,jsonb_object_agg(facet_id,decision) value from valid_facets group by company_id
 ), timing as (
  select t.company_id,jsonb_agg(jsonb_build_object('id',t.id,'type',t.type,'summary',t.summary,
   'source_name',t.source_name,'source_url',t.source_url,'signal_date',t.signal_date,
   -- All fields used by the existing visibility/identity/timing policy remain.
   -- Raw provider answers and long source passages are read on the lead, not
   -- copied across every prospect merely to determine a dated ordering tie.
   'metadata',jsonb_build_object(
    'stanley_quarantine',t.metadata->'stanley_quarantine',
    'contractEventMergedInto',t.metadata->'contractEventMergedInto',
    'contractTimingInactive',t.metadata->'contractTimingInactive',
    'intelligenceFeedbackExcluded',t.metadata->'intelligenceFeedbackExcluded',
    'jevFinding',jsonb_build_object('eventId',t.metadata->'jevFinding'->'eventId',
     'attributes',t.metadata->'jevFinding'->'attributes')))
   order by t.signal_date desc,t.id) value
  from triggers t join eligible c on c.id=t.company_id
  where t.signal_date between now()-interval '180 days' and now()
   and t.type in ('ma','m_and_a','finance_hire','new_entity','new_facility','new_location','fleet_expansion',
    'new_service_line','new_service','erp_tech','federal_award','federal_subaward','sam_award_notice','government_announcement','operating_change')
  group by t.company_id
 ) select jsonb_build_object('accounts',coalesce(jsonb_agg(jsonb_build_object(
  'industryIds',case when exists(select 1 from valid_facets vf where vf.company_id=c.id and vf.facet_id like 'industry_context_%') then (select coalesce(jsonb_agg(regexp_replace(vf.facet_id,'^industry_context_','') order by vf.facet_id),'[]'::jsonb) from valid_facets vf where vf.company_id=c.id and vf.facet_id like 'industry_context_%' and vf.decision='supported') else null end,'companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,'internalId',c.netsuite_internal_id,
  'status',coalesce(c.status,'new'),'description',c.description,'ns_industry',c.ns_industry,'record_dead',c.record_dead,
  'decisions',coalesce(d.value,'{}'::jsonb),'triggers',coalesce(t.value,'[]'::jsonb)) order by c.id),'[]'::jsonb),'asOf',now())
 from eligible c left join decisions d on d.company_id=c.id left join timing t on t.company_id=c.id
 );
end $$;
create or replace function public.intelligence_customer_match_evidence(
 p_selection jsonb,p_catalog_version text,p_facet_versions jsonb)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off set statement_timeout='18000ms' as $$
begin

 perform intelligence_catalog_validate_read(p_catalog_version,p_facet_versions);
 if p_selection is null or jsonb_typeof(p_selection)<>'array' or jsonb_array_length(p_selection)>25
  or p_catalog_version is null or length(p_catalog_version)>120 or p_facet_versions is null
  or jsonb_typeof(p_facet_versions)<>'object' then raise exception 'Invalid customer match evidence query'; end if;
 return (
 with selected as materialized (
  select (item->>'companyId')::uuid company_id,item->'facets' facets from jsonb_array_elements(p_selection) item
 ), facets as materialized (
  select f.company_id,f.facet_id,f.facet_version,f.catalog_version,f.status,f.decision,f.probability,f.native_result,
   coalesce(cs.citations,f.citations) citations
  from selected s join intelligence_catalog_read_facets f on f.company_id=s.company_id
  join intelligence_catalog_read_accounts a on a.company_id=f.company_id and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where s.facets ? f.facet_id and f.catalog_version=p_catalog_version and f.status='answered' and f.decision='supported'
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.native_result->'answer'->>'type'='choice' and f.native_result->'answer'->>'choice'='supported'
 ), valid as materialized (
  select f.* from facets f where jsonb_array_length(f.citations)>0 and not exists(
   select 1 from jsonb_array_elements(f.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=f.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
 ), source_ids as materialized (
  select distinct f.company_id,cite->>'observationId' id from valid f cross join lateral jsonb_array_elements(f.citations) cite
 ), sources as (
  select s.company_id,jsonb_agg(jsonb_build_object('id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
   'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'content_hash',o.content_hash,'attributes',null)
   order by o.id) value from source_ids s join intelligence_observations o on o.id=s.id::uuid and o.company_id=s.company_id group by s.company_id
 ), facet_rows as (
  select company_id,jsonb_agg(jsonb_build_object('id',facet_id,'facetVersion',facet_version,'catalogVersion',catalog_version,'status',status,
   'decision',decision,'probability',probability,'nativeResult',native_result,'citations',citations) order by facet_id) value
  from valid group by company_id
 ) select coalesce(jsonb_agg(jsonb_build_object('companyId',s.company_id,'observations',coalesce(o.value,'[]'::jsonb),
  'catalogFacets',coalesce(f.value,'[]'::jsonb)) order by s.company_id),'[]'::jsonb)
 from selected s left join sources o on o.company_id=s.company_id left join facet_rows f on f.company_id=s.company_id
 );
end $$;
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
 perform intelligence_catalog_validate_read(p_catalog_version,p_facet_versions);
 if exists(select 1 from intelligence_catalog_dictionaries where version=p_catalog_version and status='approved') then
  select array_agg(facet_id order by facet_id) into v_facets from intelligence_catalog_dictionary_facets where catalog_version=p_catalog_version and kind='criterion';
  v_legacy := '{}'::text[];
 end if;
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
  -- Separate branches retain compact covering-index reads. Mentioning raw
  -- evidence in CASE/COALESCE forces wide heap access even with filled caches.
  select o.id,o.company_id,o.observed_at,o.cached_operating_topics as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where p_visibility='supported' and o.is_current and not o.feedback_excluded
  union all
  select o.id,o.company_id,o.observed_at,o.cached_exploratory_topics as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where p_visibility='explore' and o.is_current and not o.feedback_excluded and o.cached_exploratory_topics is not null
  union all
  select o.id,o.company_id,o.observed_at,intelligence_exploratory_topics(o.attributes,o.evidence_text) as topics
  from intelligence_observations o join eligible c on c.id=o.company_id
  where p_visibility='explore' and o.is_current and not o.feedback_excluded and o.cached_exploratory_topics is null
 ), supported_facets as materialized (
  select f.company_id,f.facet_id,f.evidence_key,f.citation_set_key,f.citations
  from intelligence_catalog_read_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_read_accounts a on a.company_id=f.company_id
   and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered' and f.decision='supported'
   and f.facet_version=p_facet_versions->>f.facet_id and f.facet_id=any(v_facets)
   and f.native_result->'answer'->>'type'='choice' and f.native_result->'answer'->>'choice'=f.decision
 ), shared_sets as materialized (
  select distinct f.company_id,f.evidence_key,cs.citation_set_key,cs.citations
  from supported_facets f join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
 ), valid_shared_sets as materialized (
  select s.company_id,s.evidence_key,s.citation_set_key from shared_sets s
  where jsonb_array_length(s.citations)>0
   and not exists(select 1 from jsonb_array_elements(s.citations) cite
    where not exists(select 1 from intelligence_observations o
     where o.id=case when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end and o.company_id=s.company_id
      and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
 ), catalog as materialized (
  select f.company_id,f.facet_id from supported_facets f
  join valid_shared_sets s on s.citation_set_key=f.citation_set_key
   and s.company_id=f.company_id and s.evidence_key=f.evidence_key
  union all
  -- Preserve legacy inline citations, including a nonmatching shared-set
  -- identity/evidence key: the previous COALESCE used inline data in that case.
  select f.company_id,f.facet_id from supported_facets f
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where cs.citation_set_key is null and jsonb_array_length(f.citations)>0
   -- These are provenance checks, never another model judging Jev's decision.
   and not exists(select 1 from jsonb_array_elements(f.citations) cite
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
  select f.company_id,f.facet_id,f.facet_version,f.catalog_version,f.status,f.decision,f.probability,f.native_result,
   coalesce(cs.citations,f.citations) citations from intelligence_catalog_read_facets f
  join catalog valid on valid.company_id=f.company_id and valid.facet_id=f.facet_id
  join shown c on c.id=f.company_id
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where f.facet_id=any(v_topics) and f.catalog_version=p_catalog_version and f.facet_version=p_facet_versions->>f.facet_id
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
  select company_id,jsonb_agg(jsonb_build_object('id',facet_id,'facetVersion',facet_version,'catalogVersion',catalog_version,'status',status,
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
  select f.company_id,count(*) answered from intelligence_catalog_read_facets f join intelligence_catalog_read_accounts a on a.company_id=f.company_id and a.catalog_version=f.catalog_version
  where f.catalog_version=p_catalog_version and a.catalog_version=p_catalog_version and f.evidence_key=a.evidence_key
   and f.facet_version=p_facet_versions->>f.facet_id and f.status='answered' and f.facet_id=any(v_facets) group by f.company_id
 ), catalog_stats as (
  select count(*) filter(where a.status='complete' and v.answered=cardinality(v_facets)) complete,
   count(*) filter(where coalesce(v.answered,0)>0 and not(a.status='complete' and v.answered=cardinality(v_facets))) partial,
   count(*) filter(where a.status='blocked') blocked,
   count(*) filter(where coalesce(v.answered,0)=0) pending
  from eligible c left join intelligence_catalog_read_accounts a on a.company_id=c.id and a.catalog_version=p_catalog_version
  left join version_counts v on v.company_id=c.id
 ) select jsonb_build_object(
  'enabled',true,'topics',v_topics,'mode',p_mode,'showHidden',p_show_hidden,'visibility',p_visibility,'combinations',p_combinations,
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0)) from unnest(v_legacy||v_facets) known(topic)
   left join topic_counts t on t.topic=known.topic),
  'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
  'hasMore',(select count(*)>p_limit from page),
  'nextCursor',case when (select count(*)>p_limit from page) then (select id from shown order by id desc limit 1) else null end,
  'catalogCoverage',jsonb_build_object('version',p_catalog_version,'total',(select count(*) from eligible),
   'publicFacets',cardinality(v_facets),'contextOnlyFacets',0,'complete',cs.complete,'partial',cs.partial,'blocked',cs.blocked,'pending',cs.pending),
  'coverage',jsonb_build_object('tamAccounts',(select count(*) from eligible),
   'accountsWithTopicEvidence',(select count(distinct company_id) from account_topics),
   'currentObservations',totals.observations,'interpretedObservations',totals.interpreted,
   'matchingAccounts',(select count(*) from matched),
   'accountsWithNoInterpretedEvidence',(select count(*) from eligible)-totals.interpreted_accounts,
   'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible)-(select count(*) from selected_accounts) else null end,
   'asOf',now(),'cacheOnly',true)) from totals cross join catalog_stats cs
 );
end $$;

revoke all on function public.intelligence_customer_match_candidates(text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.intelligence_customer_match_evidence(jsonb,text,jsonb) from public,anon,authenticated;
revoke all on function public.intelligence_catalog_topic_search(text[],text,jsonb,uuid,integer,text,boolean,text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_customer_match_candidates(text,jsonb,boolean) to service_role;
grant execute on function public.intelligence_customer_match_evidence(jsonb,text,jsonb) to service_role;
grant execute on function public.intelligence_catalog_topic_search(text[],text,jsonb,uuid,integer,text,boolean,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
