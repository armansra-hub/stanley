-- Compact source-scoped progress; no changes to source leases or existing holds.
create table if not exists public.company_federal_source_coverage (
  company_id uuid not null references public.companies(id) on delete cascade,
  source text not null check (source in ('federal-discovery','usaspending','usaspending-subawards','sam-entity')),
  status text not null check (status in ('partial','complete','no_match','ambiguous','failed')),
  scope text not null,
  searched_from date,
  searched_through date,
  last_attempted_at timestamptz not null default now(),
  last_completed_at timestamptz,
  detail jsonb not null default '{}'::jsonb,
  primary key (company_id, source)
);
alter table public.company_federal_source_coverage enable row level security;
revoke all on public.company_federal_source_coverage from anon, authenticated;
grant select, insert, update, delete on public.company_federal_source_coverage to service_role;
comment on table public.company_federal_source_coverage is
  'Source-scoped attempts only. Complete is not an exhaustive federal-market coverage assertion.';
