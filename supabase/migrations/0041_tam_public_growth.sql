-- 0041: TAM-only public growth intelligence.
-- Raw public facts remain separate from NetSuite TAM / Old Gold grades. Meaningful
-- changes publish trigger rows for the Triggered workspace and expanded lead view.

alter table triggers add column if not exists family text;
alter table triggers add column if not exists confidence numeric;
alter table triggers add column if not exists dedupe_key text;
alter table triggers add column if not exists metadata jsonb not null default '{}'::jsonb;
create unique index if not exists triggers_dedupe_key_idx
  on triggers (company_id, dedupe_key) where dedupe_key is not null;
create index if not exists triggers_family_idx on triggers (family, signal_date desc);

create table if not exists government_entities (
  id uuid primary key default gen_random_uuid(),
  uei text,
  cage_code text,
  usaspending_recipient_id text,
  legal_name text not null,
  dba_name text,
  website text,
  domain text,
  address_line1 text,
  city text,
  state text,
  postal_code text,
  country_code text,
  registration_status text,
  registration_date date,
  expiration_date date,
  entity_start_date date,
  parent_uei text,
  parent_name text,
  source text not null,
  source_url text,
  source_updated_at timestamptz,
  observed_at timestamptz not null default now(),
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb
);
create unique index if not exists government_entities_uei_idx on government_entities (uei) where uei is not null;
create unique index if not exists government_entities_cage_idx on government_entities (cage_code) where cage_code is not null;
create unique index if not exists government_entities_recipient_idx on government_entities (usaspending_recipient_id) where usaspending_recipient_id is not null;
create index if not exists government_entities_domain_idx on government_entities (domain) where domain is not null;
create index if not exists government_entities_name_idx on government_entities (lower(legal_name));

create table if not exists company_government_matches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  government_entity_id uuid not null references government_entities(id) on delete cascade,
  match_status text not null default 'pending' check (match_status in ('pending','verified','rejected')),
  match_method text not null,
  confidence numeric not null default 0 check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  verified_by text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, government_entity_id)
);
create index if not exists company_government_matches_company_idx on company_government_matches (company_id, match_status);
create index if not exists company_government_matches_entity_idx on company_government_matches (government_entity_id, match_status);

create table if not exists federal_awards (
  id uuid primary key default gen_random_uuid(),
  government_entity_id uuid not null references government_entities(id) on delete cascade,
  generated_award_id text not null,
  award_id text,
  parent_award_id text,
  award_type text,
  awarding_agency text,
  awarding_subagency text,
  funding_agency text,
  funding_subagency text,
  awarding_office text,
  naics_code text,
  psc_code text,
  description text,
  start_date date,
  end_date date,
  potential_end_date date,
  award_ceiling numeric,
  current_award_amount numeric,
  total_obligations numeric,
  source_url text not null,
  source_updated_at timestamptz,
  observed_at timestamptz not null default now(),
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  unique (generated_award_id)
);
create index if not exists federal_awards_entity_idx on federal_awards (government_entity_id, start_date desc);
create index if not exists federal_awards_end_idx on federal_awards (end_date) where end_date is not null;
create index if not exists federal_awards_agency_idx on federal_awards (awarding_agency, awarding_subagency);

create table if not exists federal_award_transactions (
  id uuid primary key default gen_random_uuid(),
  federal_award_id uuid not null references federal_awards(id) on delete cascade,
  external_transaction_id text not null,
  action_date date not null,
  action_type text,
  modification_number text,
  federal_action_obligation numeric not null default 0,
  current_award_amount numeric,
  description text,
  source_url text,
  source_updated_at timestamptz,
  observed_at timestamptz not null default now(),
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  unique (external_transaction_id)
);
create index if not exists federal_transactions_award_date_idx on federal_award_transactions (federal_award_id, action_date desc);
create index if not exists federal_transactions_date_idx on federal_award_transactions (action_date desc);

create table if not exists federal_subawards (
  id uuid primary key default gen_random_uuid(),
  external_subaward_id text not null,
  prime_award_generated_id text,
  prime_government_entity_id uuid references government_entities(id) on delete set null,
  subaward_government_entity_id uuid references government_entities(id) on delete set null,
  subawardee_name text,
  subaward_amount numeric,
  action_date date,
  description text,
  awarding_agency text,
  source_url text,
  observed_at timestamptz not null default now(),
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  unique (external_subaward_id)
);
create index if not exists federal_subawards_sub_idx on federal_subawards (subaward_government_entity_id, action_date desc);
create index if not exists federal_subawards_prime_idx on federal_subawards (prime_government_entity_id, action_date desc);

create table if not exists company_contract_metric_snapshots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  as_of_date date not null,
  obligations_30d numeric not null default 0,
  prior_obligations_30d numeric not null default 0,
  obligations_90d numeric not null default 0,
  prior_obligations_90d numeric not null default 0,
  obligations_365d numeric not null default 0,
  prior_obligations_365d numeric not null default 0,
  ttm_delta numeric not null default 0,
  ttm_growth_pct numeric,
  new_awards_30d int not null default 0,
  new_awards_90d int not null default 0,
  new_awards_365d int not null default 0,
  transaction_count_90d int not null default 0,
  positive_modifications_90d int not null default 0,
  positive_modification_dollars_90d numeric not null default 0,
  deobligation_dollars_90d numeric not null default 0,
  active_award_count int not null default 0,
  active_award_ceiling numeric not null default 0,
  active_award_obligations numeric not null default 0,
  agency_count_365d int not null default 0,
  new_agencies jsonb not null default '[]'::jsonb,
  largest_award_ceiling numeric,
  largest_award_obligations numeric,
  largest_transaction numeric,
  first_award_date date,
  latest_award_date date,
  expiring_awards_180d int not null default 0,
  prime_subaward_dollars_365d numeric not null default 0,
  received_subaward_dollars_365d numeric not null default 0,
  metrics jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (company_id, as_of_date)
);
create index if not exists contract_metrics_growth_idx on company_contract_metric_snapshots (ttm_growth_pct desc nulls last);
create index if not exists contract_metrics_obligations_idx on company_contract_metric_snapshots (obligations_365d desc);

create table if not exists sam_opportunities (
  id uuid primary key default gen_random_uuid(),
  notice_id text not null,
  solicitation_number text,
  award_number text,
  notice_type text,
  status text,
  title text not null,
  description text,
  agency text,
  subagency text,
  office text,
  naics_code text,
  psc_code text,
  set_aside text,
  posted_date date,
  response_deadline timestamptz,
  archive_date date,
  place_of_performance jsonb not null default '{}'::jsonb,
  awardee_name text,
  awardee_uei text,
  award_amount numeric,
  source_url text not null,
  payload_hash text,
  observed_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  unique (notice_id)
);
create index if not exists sam_opportunities_posted_idx on sam_opportunities (posted_date desc);
create index if not exists sam_opportunities_agency_idx on sam_opportunities (agency, naics_code, psc_code);

create table if not exists company_opportunity_matches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  opportunity_id uuid not null references sam_opportunities(id) on delete cascade,
  relationship text not null,
  confidence numeric not null default 0 check (confidence between 0 and 1),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, opportunity_id, relationship)
);
create index if not exists company_opportunity_matches_company_idx on company_opportunity_matches (company_id, status);

create table if not exists entity_naics_size_status_snapshots (
  id uuid primary key default gen_random_uuid(),
  government_entity_id uuid not null references government_entities(id) on delete cascade,
  naics_code text not null,
  naics_name text,
  is_primary boolean not null default false,
  status text not null check (status in ('small','other_than_small','unknown')),
  has_size_changed boolean,
  has_sba_protest boolean,
  exception_counter text not null default '',
  size_standard_value numeric,
  size_standard_unit text,
  source text not null,
  source_url text,
  observed_on date not null,
  observed_at timestamptz not null default now(),
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  unique (government_entity_id, naics_code, exception_counter, observed_on)
);
create index if not exists entity_naics_size_latest_idx on entity_naics_size_status_snapshots (government_entity_id, observed_on desc);

create table if not exists form5500_headcount_observations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  filing_id text not null,
  form_type text not null,
  sponsor_ein text,
  sponsor_name text not null,
  sponsor_dba text,
  sponsor_city text,
  sponsor_state text,
  sponsor_zip text,
  plan_number text not null,
  plan_name text,
  form_year int not null,
  plan_year_begin date,
  plan_year_end date,
  active_participants_boy int,
  active_participants_eoy int,
  match_method text not null,
  match_confidence numeric not null check (match_confidence between 0 and 1),
  source_url text not null,
  payload_hash text,
  observed_at timestamptz not null default now(),
  evidence jsonb not null default '{}'::jsonb,
  unique (company_id, filing_id)
);
create index if not exists form5500_company_year_idx on form5500_headcount_observations (company_id, form_year desc);
create index if not exists form5500_plan_idx on form5500_headcount_observations (sponsor_ein, plan_number, form_year desc);

create table if not exists company_revenue_observations (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies(id) on delete cascade,
  source text not null,
  observed_on date not null,
  estimated_revenue numeric,
  revenue_band text,
  source_url text,
  payload_hash text,
  evidence jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now(),
  unique (company_id, source, observed_on)
);
create index if not exists company_revenue_latest_idx on company_revenue_observations (company_id, observed_on desc);

create table if not exists public_growth_sweep_state (
  source text primary key,
  cursor jsonb not null default '{}'::jsonb,
  last_started_at timestamptz,
  last_succeeded_at timestamptz,
  last_error text,
  last_receipt jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Public-source intelligence is server-only. The service role used by Stanley's
-- collectors bypasses RLS; browser anon/authenticated clients receive no direct
-- table access because no policies are defined here.
alter table government_entities enable row level security;
alter table company_government_matches enable row level security;
alter table federal_awards enable row level security;
alter table federal_award_transactions enable row level security;
alter table federal_subawards enable row level security;
alter table company_contract_metric_snapshots enable row level security;
alter table sam_opportunities enable row level security;
alter table company_opportunity_matches enable row level security;
alter table entity_naics_size_status_snapshots enable row level security;
alter table form5500_headcount_observations enable row level security;
alter table company_revenue_observations enable row level security;
alter table public_growth_sweep_state enable row level security;
