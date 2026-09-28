-- Cached customer comparisons are a read-side view of the existing operating
-- catalog. This creates no TAM memberships, grades, scheduler or grading queue.
begin;
create table if not exists public.intelligence_customer_references (
 id text primary key,
 catalog_version text not null,
 evidence_key text not null,
 status text not null default 'pending' check(status in ('pending','running','complete','blocked')),
 result jsonb,
 checkpoint jsonb,
 lease_token uuid,
 lease_until timestamptz,
 updated_at timestamptz not null default now()
);
alter table public.intelligence_customer_references enable row level security;
revoke all on public.intelligence_customer_references from public,anon,authenticated;
grant select,insert,update,delete on public.intelligence_customer_references to service_role;

-- Aggregate into one JSON value so PostgREST's row limit cannot quietly omit
-- accounts from ranking or counts. Only compact decisions cross this boundary.
create or replace function public.intelligence_customer_match_candidates(
 p_catalog_version text,p_facet_versions jsonb,p_show_hidden boolean default false)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off set statement_timeout='18000ms' as $$
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
  select f.company_id,f.facet_id,f.decision,f.evidence_key,f.citation_set_key,f.citations
  from intelligence_catalog_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_accounts a on a.company_id=f.company_id
   and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered'
   and f.decision in ('supported','not_supported','conflicting')
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.native_result->'answer'->>'type'='choice'
   and f.native_result->'answer'->>'choice'=f.decision
 ), shared_sets as materialized (
  select distinct f.company_id,f.evidence_key,cs.citation_set_key,cs.citations
  from facets f join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
 ), valid_sets as materialized (
  select s.company_id,s.evidence_key,s.citation_set_key from shared_sets s
  where jsonb_array_length(s.citations)>0 and not exists(
   select 1 from jsonb_array_elements(s.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=s.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
 ), valid_facets as materialized (
  select f.company_id,f.facet_id,f.decision from facets f join valid_sets s
   on s.citation_set_key=f.citation_set_key and s.company_id=f.company_id and s.evidence_key=f.evidence_key
  union all
  select f.company_id,f.facet_id,f.decision from facets f
  left join intelligence_catalog_citation_sets cs on cs.citation_set_key=f.citation_set_key
   and cs.company_id=f.company_id and cs.evidence_key=f.evidence_key
  where cs.citation_set_key is null and jsonb_array_length(f.citations)>0 and not exists(
   select 1 from jsonb_array_elements(f.citations) cite where not exists(
    select 1 from intelligence_observations o where o.id=case
     when cite->>'observationId' ~ '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' then (cite->>'observationId')::uuid end
     and o.company_id=f.company_id and o.is_current and not o.feedback_excluded and o.content_hash=cite->>'contentHash'))
  union all
  -- A native unknown may correctly have no candidate source. It still records
  -- an evaluated question; absence of proof never becomes a supported match.
  select f.company_id,f.facet_id,f.decision
  from intelligence_catalog_facets f join eligible c on c.id=f.company_id
  join intelligence_catalog_accounts a on a.company_id=f.company_id
   and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
  where f.catalog_version=p_catalog_version and f.status='answered' and f.decision='insufficient_evidence'
   and f.facet_version=p_facet_versions->>f.facet_id
   and f.native_result->'answer'->>'type'='choice'
   and f.native_result->'answer'->>'choice'='insufficient_evidence'
 ), decisions as (
  select company_id,jsonb_object_agg(facet_id,decision) value from valid_facets group by company_id
 ), timing as (
  select t.company_id,jsonb_agg(jsonb_build_object('id',t.id,'type',t.type,'summary',t.summary,
   'source_name',t.source_name,'source_url',t.source_url,'signal_date',t.signal_date,'metadata',t.metadata)
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

-- Hydrate only the requested page's shared traits. A concurrent source change
-- fails closed against the same account evidence key; no stale proof is shown.
create or replace function public.intelligence_customer_match_evidence(
 p_selection jsonb,p_catalog_version text,p_facet_versions jsonb)
returns jsonb language plpgsql stable security definer
set search_path=public,pg_temp set jit=off set statement_timeout='18000ms' as $$
begin
 if p_selection is null or jsonb_typeof(p_selection)<>'array' or jsonb_array_length(p_selection)>25
  or p_catalog_version is null or length(p_catalog_version)>120 or p_facet_versions is null
  or jsonb_typeof(p_facet_versions)<>'object' then raise exception 'Invalid customer match evidence query'; end if;
 return (
 with selected as materialized (
  select (item->>'companyId')::uuid company_id,item->'facets' facets from jsonb_array_elements(p_selection) item
 ), facets as materialized (
  select f.company_id,f.facet_id,f.catalog_version,f.status,f.decision,f.probability,f.native_result,
   coalesce(cs.citations,f.citations) citations
  from selected s join intelligence_catalog_facets f on f.company_id=s.company_id
  join intelligence_catalog_accounts a on a.company_id=f.company_id and a.catalog_version=f.catalog_version and a.evidence_key=f.evidence_key
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
  select company_id,jsonb_agg(jsonb_build_object('id',facet_id,'catalogVersion',catalog_version,'status',status,
   'decision',decision,'probability',probability,'nativeResult',native_result,'citations',citations) order by facet_id) value
  from valid group by company_id
 ) select coalesce(jsonb_agg(jsonb_build_object('companyId',s.company_id,'observations',coalesce(o.value,'[]'::jsonb),
  'catalogFacets',coalesce(f.value,'[]'::jsonb)) order by s.company_id),'[]'::jsonb)
 from selected s left join sources o on o.company_id=s.company_id left join facet_rows f on f.company_id=s.company_id
 );
end $$;
revoke all on function public.intelligence_customer_match_candidates(text,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.intelligence_customer_match_evidence(jsonb,text,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_customer_match_candidates(text,jsonb,boolean) to service_role;
grant execute on function public.intelligence_customer_match_evidence(jsonb,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
