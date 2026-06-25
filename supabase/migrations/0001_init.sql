-- Jarvis — Prospecting module schema (Supabase / Postgres)
-- Merged from both build briefs. Architected so `reminders` and
-- `pipeline_tracker` modules can be added later as sibling tables.

create extension if not exists pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────
-- Config: territory (single editable row)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists territory_config (
  id            int primary key default 1,
  subindustries text[]  not null default '{}',   -- ZoomInfo subindustry allowlist (HARD gate)
  industries    text[]  not null default '{}',   -- the 4 NSCorp buckets (display/grouping)
  naics_codes   text[]  not null default '{}',   -- added later
  states        text[]  not null default '{}',   -- hard-filters ONLY Google Maps results
  revenue_min   numeric,                          -- display only, NOT a filter
  revenue_max   numeric,
  employees_min int,
  employees_max int,
  updated_at    timestamptz not null default now(),
  constraint territory_config_singleton check (id = 1)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Config: app settings (single editable row) — actors, models, export knobs
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists app_config (
  id                      int primary key default 1,
  model_bulk              text    not null default 'claude-haiku-4-5',   -- classify/score summaries
  model_chat              text    not null default 'claude-opus-4-8',    -- chatbot/voice agent
  chunk_size              int     not null default 40,                   -- SQL export domains/formula
  sql_url_field           text    not null default '{url}',              -- NetSuite Web Address token
  ns_stage                text    not null default 'Lead',
  ns_sales_rep            text    not null default 'Nurturing Marketing',
  refresh_interval_minutes int    not null default 720,
  max_cost_per_run_usd    numeric not null default 5.0,                  -- per-actor Apify cap
  edgar_user_agent_email  text    not null default 'armansra@gmail.com', -- SEC fair-access (required)
  actors                  jsonb   not null default '{}'::jsonb,          -- { google_maps, crunchbase, ... : {actor_id,input_template,enabled} }
  news_rss_feeds          text[]  not null default '{}',
  job_queries             text[]  not null default '{}',
  updated_at              timestamptz not null default now(),
  constraint app_config_singleton check (id = 1)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Config: scoring weights (tunable rules — deterministic 0–100 score)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists scoring_weights (
  signal_type text not null,
  strength    text not null,             -- weak | medium | strong | any
  weight      int  not null,
  primary key (signal_type, strength)
);

-- ─────────────────────────────────────────────────────────────────────────
-- Companies (dedupe on normalized domain)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists companies (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  domain         text unique,                  -- normalized; the dedupe key
  website_raw    text,
  description    text,                          -- "what they do" (LLM, one neutral sentence)
  subindustry    text,                          -- one of territory_config.subindustries (LLM)
  ns_industry    text,                          -- the parent bucket
  in_territory   boolean not null default true,
  territory_fit  numeric,                       -- 0–1 (LLM)
  source         text not null default 'discovered',  -- discovered | imported
  status         text not null default 'new',         -- new | reviewed | dismissed | exported_csv | exported_sql
  state          text,
  city           text,
  employee_band  text,
  revenue_band   text,
  signal_score   int  not null default 0,       -- deterministic 0–100 (rules+weights)
  score_tier     text,                          -- A | B | C (independent LLM tier)
  score_reason   text,                          -- short rationale referencing signals
  has_new_signal boolean not null default false,-- drives notification dot (imported companies)
  sources        jsonb not null default '[]'::jsonb,  -- which scrapers/feeds found it
  import_batch_id uuid,
  notes          text,
  first_seen_at  timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  exported_at    timestamptz,
  check (source in ('discovered','imported')),
  check (status in ('new','reviewed','dismissed','exported_csv','exported_sql')),
  check (score_tier is null or score_tier in ('A','B','C'))
);
create index if not exists companies_status_idx       on companies (status);
create index if not exists companies_source_idx       on companies (source);
create index if not exists companies_subindustry_idx  on companies (subindustry);
create index if not exists companies_state_idx        on companies (state);
create index if not exists companies_score_idx        on companies (signal_score desc);

-- ─────────────────────────────────────────────────────────────────────────
-- Signals (every row MUST carry a real source_url — hard rule)
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists signals (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references companies(id) on delete cascade,
  type                 text not null,           -- finance_hire | pain_job_post | hiring_velocity |
                                                --   funding | m_and_a | new_entity | gov_contract |
                                                --   new_facility | fleet_expansion | new_service_line |
                                                --   new_location | new_service | ex_netsuite_alum |
                                                --   tech_stack | intent | job_post | news
  strength             text not null default 'medium',  -- weak | medium | strong
  weight               int  not null default 0,          -- contribution to signal_score
  source_name          text,                    -- "Indeed", "SEC EDGAR", "Google News", ...
  source_url           text not null,           -- REQUIRED — the evidence link
  raw_excerpt          text,                    -- the snippet the signal is based on
  signal_summary       text,                    -- LLM, one sentence, derived ONLY from raw_excerpt
  subindustry_relevant boolean not null default false,  -- vertical-specific pain vs generic growth
  detected_at          timestamptz not null default now(),
  check (strength in ('weak','medium','strong'))
);
create index if not exists signals_company_idx on signals (company_id);
create index if not exists signals_type_idx    on signals (type);

-- ─────────────────────────────────────────────────────────────────────────
-- Exports / imports / chat history
-- ─────────────────────────────────────────────────────────────────────────
create table if not exists exports (
  id          uuid primary key default gen_random_uuid(),
  export_type text not null,                    -- sql | csv
  company_ids jsonb not null default '[]'::jsonb,
  payload     text,
  created_at  timestamptz not null default now(),
  check (export_type in ('sql','csv'))
);

create table if not exists import_batches (
  id             uuid primary key default gen_random_uuid(),
  filename       text,
  row_count      int  not null default 0,
  enriched_count int  not null default 0,
  uploaded_at    timestamptz not null default now()
);

create table if not exists chat_messages (
  id         uuid primary key default gen_random_uuid(),
  role       text not null,                     -- user | assistant | tool
  content    text not null,
  created_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- Seed: config singletons + scoring weights
-- ─────────────────────────────────────────────────────────────────────────
insert into territory_config (id, subindustries, industries, states, revenue_min, revenue_max, employees_min, employees_max)
values (
  1,
  array[
    -- Media / Advertising / Publishing
    'Advertising & Marketing','Multimedia & Graphic Design','Broadcasting','Media & Internet',
    'Music Production & Services','Newspapers & News Services','Publishing','Social Networks',
    -- Business Services
    'Accounting Services','Business Services','Call Centers & Business Centers',
    'Facilities Management & Commercial Cleaning','HR & Staffing','Information & Document Management',
    'Translation & Linguistic Services','Law Firms & Legal Services',
    -- Consulting
    'Management Consulting',
    -- Transportation / Logistics
    'Car & Truck Rental','Airlines, Airports & Air Services','Freight & Logistics Services',
    'Marine Shipping & Transportation','Rail, Bus & Taxi','Transportation','Trucking, Moving & Storage'
  ],
  array['Media / Advertising / Publishing','Business Services','Consulting','Transportation / Logistics'],
  array[
    'CA','AZ','CO','WA','MN','UT','OR','NV','OK','KS','ID','NE','NM','WY','HI','AK','MT','SD','ND',
    'TX','IL','MO','WI','IA','AR',          -- US states
    'BC','AB','YT','NT','NU',               -- Canada
    'GU','PR'                               -- US territories
  ],
  5000000, 50000000, 1, 500
)
on conflict (id) do nothing;

insert into app_config (id) values (1) on conflict (id) do nothing;

insert into scoring_weights (signal_type, strength, weight) values
  ('finance_hire','strong',35), ('finance_hire','medium',20),
  ('pain_job_post','strong',25), ('pain_job_post','medium',15),
  ('hiring_velocity','strong',20), ('hiring_velocity','medium',10),
  ('funding','any',20),
  ('m_and_a','any',20),
  ('new_location','any',12),
  ('new_service','any',10),
  ('ex_netsuite_alum','any',12),
  ('tech_stack','any',8),
  ('intent','any',8),
  -- complexity-spike events (NetSuite wins when complexity outgrows QuickBooks)
  ('new_entity','any',22),
  ('gov_contract','any',18),
  ('fleet_expansion','any',14),
  ('new_facility','any',12),
  ('new_service_line','any',12)
on conflict (signal_type, strength) do nothing;
