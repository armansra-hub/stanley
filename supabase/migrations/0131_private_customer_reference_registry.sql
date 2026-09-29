-- Full historical customer cohort is private operational data, not repository
-- seed content. Source capture and native results retain independent leases.
begin;
create table if not exists public.intelligence_customer_reference_registry (
 id text primary key,
 name text not null,
 domain text,
 website text,
 announcement_date date not null,
 announcement_type text not null check (announcement_type in ('new_customer','expansion','renewal','unknown')),
 buying_program_id text,
 comparison_industry text,
 identity_notes jsonb not null default '[]',
 announcements jsonb not null default '[]',
 candidate_urls jsonb not null default '[]',
 sources jsonb not null default '[]',
 source_status text not null default 'pending' check (source_status in ('pending','running','ready','blocked')),
 source_checkpoint jsonb,
 source_lease_token uuid,
 source_lease_until timestamptz,
 active boolean not null default true,
 as_of date not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check (jsonb_typeof(sources)='array' and jsonb_typeof(announcements)='array' and jsonb_typeof(candidate_urls)='array')
);
create index if not exists intelligence_customer_reference_registry_domain
 on public.intelligence_customer_reference_registry(domain) where domain is not null;
alter table public.intelligence_customer_reference_registry enable row level security;
revoke all on public.intelligence_customer_reference_registry from public,anon,authenticated;
grant select,insert,update,delete on public.intelligence_customer_reference_registry to service_role;

-- Keyset paging has no total-cohort cap. Exclude source bodies and private
-- announcement provenance from ordinary progress/matching reads.
create or replace function public.intelligence_customer_reference_registry_page(p_after text default null,p_limit integer default 250)
returns jsonb language sql stable security definer set search_path=public,pg_temp set jit=off as $$
 select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb) from (
  select r.id,r.name,r.domain,r.website,r.announcement_date,r.announcement_type,r.buying_program_id,r.comparison_industry,
   r.identity_notes,r.candidate_urls,r.source_status,r.source_lease_until,r.active,r.as_of,r.created_at,r.updated_at,
   jsonb_array_length(r.announcements) announcement_count,
   r.source_checkpoint,
   coalesce((select jsonb_agg(source-'text' order by ord) from jsonb_array_elements(r.sources) with ordinality s(source,ord)),'[]'::jsonb) sources,
   n.status native_status,n.catalog_version native_catalog_version,n.evidence_key native_evidence_key,
   coalesce((select count(*) from jsonb_object_keys(coalesce(n.checkpoint->'answers','{}'::jsonb))),0) native_answered,
   n.checkpoint->>'lastError' native_last_error,n.lease_until native_lease_until,n.updated_at native_updated_at
  from intelligence_customer_reference_registry r left join intelligence_customer_references n on n.id=r.id
  where r.active and (p_after is null or r.id>p_after) order by r.id limit greatest(1,least(p_limit,250))
 ) page;
$$;

-- Decisions and proof identities are sufficient to choose comparisons. Keep
-- complete native receipts in storage and hydrate only displayed references.
create or replace function public.intelligence_customer_reference_match_page(p_after text default null,p_limit integer default 100)
returns jsonb language sql stable security definer set search_path=public,pg_temp set jit=off as $$
 select coalesce(jsonb_agg(to_jsonb(page) order by id),'[]'::jsonb) from (
  select n.id,n.catalog_version,n.evidence_key,n.status,jsonb_build_object(
   'id',n.result->'id','catalogVersion',n.result->'catalogVersion','completedAt',n.result->'completedAt','status',n.result->'status',
   'answers',coalesce((select jsonb_object_agg(key,jsonb_build_object(
    'decision',value->'decision','facetVersion',value->'facetVersion','sourceUrls',value->'sourceUrls',
    'nativeResult',jsonb_build_object('questionId',value->'nativeResult'->'questionId','answer',value->'nativeResult'->'answer')))
    from jsonb_each(coalesce(n.result->'answers','{}'::jsonb))),'{}'::jsonb)) result
  from intelligence_customer_references n join intelligence_customer_reference_registry r on r.id=n.id
  where r.active and r.source_status='ready' and n.status='complete' and (p_after is null or n.id>p_after)
  order by n.id limit greatest(1,least(p_limit,100))
 ) page;
$$;

-- Merge bounded ledger imports atomically. Explicit audited identity reuses
-- completed reference IDs and packets; a shared host never merges businesses.
-- Repeated announcements do not duplicate
-- customers or discard historical renewal/expansion provenance.
create or replace function public.intelligence_customer_reference_import(p_records jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp set jit=off as $$
declare item jsonb; current_row intelligence_customer_reference_registry%rowtype; target_id text; receipt jsonb='[]';
begin
 if jsonb_typeof(p_records)<>'array' or jsonb_array_length(p_records)<1 or jsonb_array_length(p_records)>100 then
  raise exception 'Invalid customer registry import';
 end if;
 for item in select value from jsonb_array_elements(p_records) loop
  if length(item->>'id') not between 1 and 120 or length(item->>'name') not between 1 and 300
   or item->>'announcementType' not in ('new_customer','expansion','renewal','unknown')
   or jsonb_typeof(item->'announcements')<>'array' or jsonb_typeof(item->'candidateUrls')<>'array'
   then raise exception 'Invalid customer registry record'; end if;
  -- Serializes this reference's admission without touching any TAM work.
  target_id=coalesce(item->>'existingReferenceId',item->>'id');
  perform pg_advisory_xact_lock(hashtextextended(target_id,7931));
  select * into current_row from intelligence_customer_reference_registry
   where id=target_id for update;
  if found then
   if current_row.domain is not null and item->>'domain' is not null and current_row.domain<>item->>'domain' then
    raise exception 'Customer registry identity conflict';
   end if;
   target_id=current_row.id;
   update intelligence_customer_reference_registry set
    domain=coalesce(domain,item->>'domain'),website=coalesce(website,item->>'website'),
    announcement_date=greatest(announcement_date,(item->>'announcementDate')::date),
    announcement_type=case when (item->>'announcementDate')::date>=announcement_date then item->>'announcementType' else announcement_type end,
    buying_program_id=coalesce(buying_program_id,item->>'buyingProgramId'),
    comparison_industry=coalesce(comparison_industry,item->>'comparisonIndustry'),
    announcements=(select coalesce(jsonb_agg(value order by value->>'date',value->>'id'),'[]') from (
     select distinct on (value->>'id') value from jsonb_array_elements(current_row.announcements || (item->'announcements'))
     order by value->>'id') merged),
    candidate_urls=(select coalesce(jsonb_agg(value order by value),'[]') from (
     select distinct value from jsonb_array_elements(current_row.candidate_urls || (item->'candidateUrls'))) urls),
    source_status=case when current_row.domain is null and item->>'domain' is not null then 'pending' else source_status end,
    source_checkpoint=case when current_row.domain is null and item->>'domain' is not null then null else source_checkpoint end,
    as_of=greatest(as_of,(item->>'asOf')::date),updated_at=now()
   where id=target_id;
   receipt=receipt || jsonb_build_array(jsonb_build_object('importedId',item->>'id','id',target_id,'created',false));
  else
   if item->>'existingReferenceId' is not null then raise exception 'Unknown existing reference identity'; end if;
   insert into intelligence_customer_reference_registry(id,name,domain,website,announcement_date,announcement_type,buying_program_id,
    comparison_industry,identity_notes,announcements,candidate_urls,as_of)
   values(target_id,item->>'name',item->>'domain',item->>'website',(item->>'announcementDate')::date,item->>'announcementType',
    item->>'buyingProgramId',item->>'comparisonIndustry',coalesce(item->'identityNotes','[]'),item->'announcements',item->'candidateUrls',(item->>'asOf')::date);
   receipt=receipt || jsonb_build_array(jsonb_build_object('importedId',item->>'id','id',target_id,'created',true));
  end if;
 end loop;
 return jsonb_build_object('imported',jsonb_array_length(p_records),'records',receipt);
end $$;
revoke all on function public.intelligence_customer_reference_registry_page(text,integer) from public,anon,authenticated;
revoke all on function public.intelligence_customer_reference_match_page(text,integer) from public,anon,authenticated;
revoke all on function public.intelligence_customer_reference_import(jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_customer_reference_registry_page(text,integer) to service_role;
grant execute on function public.intelligence_customer_reference_match_page(text,integer) to service_role;
grant execute on function public.intelligence_customer_reference_import(jsonb) to service_role;
notify pgrst,'reload schema';
commit;
