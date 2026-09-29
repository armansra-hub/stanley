-- Read-only comparison acceleration: the observed live plan spent 6.42 seconds
-- fetching current observation proof rows and 3.47 seconds fetching decisive
-- facet rows. These indexes cover the existing exact predicates and identities;
-- native answers, source bodies, hashes, exclusions and every candidate remain.
-- No worker, claim, request, grading, membership or visibility changes.
-- Run EACH concurrent index statement separately, outside a transaction. If an
-- action becomes uncertain, inspect pg_index.indisvalid before retrying it.
create index concurrently intelligence_current_observation_proof
 on public.intelligence_observations(company_id,id) include(content_hash)
 where is_current and not feedback_excluded;

create index concurrently intelligence_catalog_decisive_native_read
 on public.intelligence_catalog_facets(catalog_version,company_id)
 include(evidence_key,facet_id,facet_version,decision,citation_set_key)
 where status='answered' and decision in ('supported','not_supported','conflicting')
  and native_result->'answer'->>'type'='choice'
  and native_result->'answer'->>'choice'=decision;
begin;
create or replace function public.intelligence_customer_match_candidates(
 p_catalog_version text,p_facet_versions jsonb,p_show_hidden boolean default false)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off set enable_nestloop=off set statement_timeout='18000ms' as $$
begin
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
  from intelligence_catalog_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_accounts a on a.company_id=f.company_id
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
  join intelligence_catalog_facets original on original.company_id=f.company_id and original.facet_id=f.facet_id
  where jsonb_array_length(original.citations)>0 and not exists(
   select 1 from jsonb_array_elements(original.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=f.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))

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
  'companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,'internalId',c.netsuite_internal_id,
  'status',coalesce(c.status,'new'),'description',c.description,'ns_industry',c.ns_industry,'record_dead',c.record_dead,
  'decisions',coalesce(d.value,'{}'::jsonb),'triggers',coalesce(t.value,'[]'::jsonb)) order by c.id),'[]'::jsonb),'asOf',now())
 from eligible c left join decisions d on d.company_id=c.id left join timing t on t.company_id=c.id
 );
end $$;
revoke all on function public.intelligence_customer_match_candidates(text,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.intelligence_customer_match_candidates(text,jsonb,boolean) to service_role;
notify pgrst,'reload schema';
commit;
