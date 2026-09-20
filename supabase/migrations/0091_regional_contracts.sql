-- Limited public regional disclosures; name matches remain candidates until a
-- source-backed explicit identity review. Never writes TAM grades or federal totals.
begin;
create table public.regional_contract_sources (
  id text primary key, name text not null, dataset_url text not null, scope text not null,
  enabled boolean not null default true, next_offset integer not null default 0 check(next_offset>=0),
  snapshot_version text, snapshot_complete boolean not null default false,
  next_attempt_at timestamptz not null default now(), last_attempt_at timestamptz, last_success_at timestamptz,
  last_complete_at timestamptz, last_error text, scanned_rows bigint not null default 0, matched_rows bigint not null default 0,
  lease_token uuid, lease_until timestamptz
);
insert into public.regional_contract_sources(id,name,dataset_url,scope) values
 ('sf_supplier_contracts','San Francisco supplier contracts','https://data.sf.gov/d/cqi5-hm2d','San Francisco published supplier contracts, generally updated weekly; confidential contracts excluded.'),
 ('wa_fy2025_contracts','Washington agency contracts — FY2025','https://data.wa.gov/d/6fx9-ncas','Historical FY2025 Washington agency contract disclosure; not a live award feed.');
create table public.regional_contract_matches (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id),
  source_id text not null references public.regional_contract_sources(id), external_key text not null,
  content_hash text not null, fact jsonb not null check(jsonb_typeof(fact)='object' and octet_length(fact::text)<=16000),
  identity_status text not null default 'candidate' check(identity_status in ('candidate','verified','rejected')),
  identity_method text not null default 'exact_name_candidate', identity_source_url text, identity_note text, reviewed_at timestamptz,
  first_observed_at timestamptz not null default now(), last_observed_at timestamptz not null default now(),
  unique(company_id,external_key)
);
create index regional_contract_account on public.regional_contract_matches(company_id,identity_status,last_observed_at desc);

create function public.regional_contract_claim(p_source text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare source public.regional_contract_sources;
begin
  if not coalesce((select enabled from public.intelligence_config where id=1),false) then return null; end if;
  select * into source from public.regional_contract_sources where id=p_source and enabled and next_attempt_at<=now()
    and (lease_until is null or lease_until<=now()) for update skip locked;
  if not found then return null; end if;
  update public.regional_contract_sources set lease_token=gen_random_uuid(),lease_until=now()+interval '4 minutes',last_attempt_at=now()
    where id=p_source returning * into source;
  return to_jsonb(source);
end $$;

create function public.regional_contract_finish(p_source text,p_lease uuid,p_offset integer,p_version text,p_complete boolean,
  p_scanned integer,p_candidates jsonb,p_error text default null) returns void
language plpgsql security definer set search_path=public,pg_temp as $$
declare source public.regional_contract_sources;
begin
  select * into source from public.regional_contract_sources where id=p_source and lease_token=p_lease and lease_until>now() for update;
  if not found then raise exception 'regional_lease_lost'; end if;
  if p_error is not null then
    update public.regional_contract_sources set last_error=left(p_error,160),next_attempt_at=now()+interval '1 hour',lease_token=null,lease_until=null where id=p_source;
    return;
  end if;
  if p_offset is null or p_scanned is null or p_complete is null or p_offset<0 or p_scanned<0 or p_scanned>500 or p_version is null or length(p_version)>100 or p_candidates is null or jsonb_typeof(p_candidates)<>'array'
    or jsonb_array_length(p_candidates)>5000 or octet_length(p_candidates::text)>4000000 then raise exception 'invalid_regional_batch'; end if;
  insert into public.regional_contract_matches(company_id,source_id,external_key,content_hash,fact,identity_status,identity_method,identity_source_url,identity_note)
    select (x->>'companyId')::uuid,p_source,x->>'externalKey',x->>'contentHash',x->'fact',
      case when witness.id is not null then 'verified' else 'candidate' end,
      case when witness.id is not null then 'company_site_contract_reference' else 'exact_name_candidate' end,
      witness.source_url,case when witness.id is not null then left(x->'identityEvidence'->>'excerpt',1200) else null end
    from jsonb_array_elements(p_candidates) x join public.companies c on c.id=(x->>'companyId')::uuid
    left join public.intelligence_observations witness on witness.id::text=x->'identityEvidence'->>'observationId'
      and witness.company_id=c.id and witness.source_kind='website' and witness.is_current and not witness.feedback_excluded
      and witness.source_url=x->'identityEvidence'->>'sourceUrl'
      and x->'identityEvidence'->>'method'='company_site_contract_reference'
      and length(x->'identityEvidence'->>'excerpt') between 20 and 1200
      and position(x->'identityEvidence'->>'excerpt' in witness.evidence_text)>0
    where c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])))
      and 'netsuite_tam'=any(coalesce(c.lists,'{}'::text[])) and c.netsuite_internal_id ~ '^[0-9]+$'
      and x->'fact'->>'sourceId'=p_source and x->>'externalKey' ~ '^[a-f0-9]{64}$' and x->>'contentHash' ~ '^[a-f0-9]{64}$'
    on conflict(company_id,external_key) do update set fact=excluded.fact,content_hash=excluded.content_hash,last_observed_at=now(),
      identity_status=case when regional_contract_matches.identity_status='candidate' and regional_contract_matches.reviewed_at is null then excluded.identity_status else regional_contract_matches.identity_status end,
      identity_method=case when regional_contract_matches.identity_status='candidate' and regional_contract_matches.reviewed_at is null then excluded.identity_method else regional_contract_matches.identity_method end,
      identity_source_url=case when regional_contract_matches.identity_status='candidate' and regional_contract_matches.reviewed_at is null then excluded.identity_source_url else regional_contract_matches.identity_source_url end,
      identity_note=case when regional_contract_matches.identity_status='candidate' and regional_contract_matches.reviewed_at is null then excluded.identity_note else regional_contract_matches.identity_note end;
  update public.regional_contract_sources set next_offset=case when p_complete then 0 else p_offset end,
    snapshot_version=p_version,snapshot_complete=p_complete,last_success_at=now(),last_error=null,
    last_complete_at=case when p_complete then now() else last_complete_at end,
    scanned_rows=scanned_rows+p_scanned,matched_rows=matched_rows+jsonb_array_length(p_candidates),
    next_attempt_at=case when p_complete then now()+interval '24 hours' else now() end,lease_token=null,lease_until=null
    where id=p_source;
end $$;

create function public.regional_contract_identity_evidence(p_companies uuid[]) returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
  select coalesce(jsonb_agg(to_jsonb(o)),'[]'::jsonb) from
    (select distinct unnest(p_companies[1:40]) company_id) requested
    cross join lateral (select id,company_id,source_url,left(evidence_text,24000) evidence_text
      from public.intelligence_observations where company_id=requested.company_id
        and source_kind='website' and is_current and not feedback_excluded
      order by observed_at desc,id limit 6) o;
$$;

create function public.regional_contract_review(p_company uuid,p_match uuid,p_status text,p_source_url text default null,p_note text default null)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_status not in ('candidate','verified','rejected') then raise exception 'invalid_regional_review'; end if;
  if p_status='verified' and (coalesce(p_source_url,'')!~'^https?://' or length(p_source_url)>2048 or length(trim(coalesce(p_note,'')))<12 or length(p_note)>500) then raise exception 'regional_identity_evidence_required'; end if;
  update public.regional_contract_matches m set identity_status=p_status,
    identity_method=case when p_status='verified' then 'user_confirmed_with_source' else 'exact_name_candidate' end,
    identity_source_url=case when p_status='verified' then p_source_url else null end,
    identity_note=case when p_status='verified' then p_note else null end,reviewed_at=now()
    where m.id=p_match and m.company_id=p_company and exists(select 1 from public.companies c where c.id=p_company
      and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[]))));
  return found;
end $$;

do $$ declare t text; f record; begin
  foreach t in array array['regional_contract_sources','regional_contract_matches'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('regional_contract_claim','regional_contract_finish','regional_contract_review','regional_contract_identity_evidence') loop
    execute format('revoke all on function %s from public,anon,authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
