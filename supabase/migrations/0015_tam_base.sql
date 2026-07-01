-- 0015: TAM Base — the new prospecting model. The AE bulk-uploads ICP-filtered
-- company lists from ZoomInfo / LinkedIn / Apollo (already filtered at source for
-- growing + ≥20 employees + in-house finance). These become the monitored base;
-- triggers (news/hiring/funding/tech) later boost them. Additive columns only —
-- existing discovered companies keep working untouched.
alter table companies add column if not exists is_base       bool   not null default false;  -- a TAM-base (vendor-imported) company
alter table companies add column if not exists lead_vendor   text;                            -- zoominfo | linkedin | apollo (primary)
alter table companies add column if not exists fit_weight    numeric not null default 1.0;    -- source-confidence weight (ZI/LI high, Apollo lower, multi-source boosted)
alter table companies add column if not exists technologies  text[];                          -- technographics from the vendor (QuickBooks, NetSuite, …)
alter table companies add column if not exists erp_ready     bool   not null default false;   -- QB-tier stack present AND no real ERP → ERP-ready
alter table companies add column if not exists employee_count int;                            -- raw headcount when the vendor provides it

create index if not exists companies_is_base_idx on companies (is_base) where is_base = true;
create index if not exists companies_domain_idx  on companies (domain) where domain is not null;
create index if not exists companies_erp_ready_idx on companies (erp_ready) where erp_ready = true;
