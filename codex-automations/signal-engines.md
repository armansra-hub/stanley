# Public-data and signal engines

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Individual source families inside Stanley; these are components, not separate deployed products.

<a id="sg01"></a>

## SG01 — Hourly rotating source orchestration

**Status:** Source present. **Purpose:** Bound each hosted ingestion invocation while covering multiple source families.

**How it works:** The historically named daily route runs hourly. One invocation executes a five-request stage from an 80-request manifest, a 16-stage rotation. Prime awards and candidate review recur each stage. Provider failures mean intended coverage is not proof of successful observation.

**Infrastructure:** Vercel cron; lib/cron; authenticated worker routes.

**Evidence:** Public: vercel.json; lib/cron/dailyPlan.ts; lib/cron/rotation.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg02"></a>

## SG02 — News discovery, identity checks, and candidate review

**Status:** Source present. **Purpose:** Find relevant company news while preventing same-name misattribution.

**How it works:** Collect RSS/news candidates, check company identity, classify qualifying evidence, and route uncertain candidates for review. URL safety and evidence requirements apply before a trigger is accepted.

**Infrastructure:** RSS parser, Google News sources, regex and model classification, review queue.

**Evidence:** Public: config/news.ts; lib/triggers/classify.ts; lib/triggers/candidateReview.ts; lib/triggers/urlSafety.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg03"></a>

## SG03 — Website, careers, ATS, and finance-hiring signals

**Status:** Source present. **Purpose:** Detect operational change and hiring evidence from company-linked surfaces.

**How it works:** Sweep known company websites and careers sources, interpret configured events, and retain attributable evidence. Source-specific thresholds and freshness are implemented in code; observed hiring is not a confirmed purchase project.

**Infrastructure:** Website/ATS sweep workers, configured data providers including Apify where used.

**Evidence:** Public: lib/triggers/websiteSweep.ts; lib/triggers/atsSweep.ts; config/actors.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg04"></a>

## SG04 — TAL-focused monitoring

**Status:** Source present. **Purpose:** Apply source discovery to the claimed account set.

**How it works:** Use TAL membership to scope a sweep, then pass candidate evidence through the same identity, classification, and freshness controls as other public triggers. Membership does not relax evidence quality.

**Infrastructure:** TAL sweep worker, company database, shared trigger pipeline.

**Evidence:** Public: lib/triggers/talSweep.ts; config/sources.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg05"></a>

## SG05 — FMCSA fleet and carrier foundation

**Status:** Source present. **Purpose:** Use carrier identity and fleet/driver observations as a growth input.

**How it works:** Foundation import and subsequent sweeps reconcile carrier data to companies and evaluate configured operational changes. Carrier observations enrich external prioritization rather than rewriting CRM grades.

**Infrastructure:** FMCSA import tooling, source foundation, sweep worker.

**Evidence:** Public: tools/run-fmcsa-foundation.ps1; lib/triggers/fmcsaSweep.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg06"></a>

## SG06 — Colorado entity and UCC monitoring

**Status:** Source present. **Purpose:** Surface attributable business-registration and financing-related changes.

**How it works:** Query supported public registry sources and evaluate configured entity/UCC events. A filing is evidence of that filing, not proof of financial distress or confirmed ERP demand.

**Infrastructure:** Colorado Secretary of State source worker and trigger rules.

**Evidence:** Public: lib/triggers/coSosSweep.ts; config/signals.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg07"></a>

## SG07 — Department of Labor Form 5500 foundation

**Status:** Source present. **Purpose:** Bring benefits-plan and employee-scale observations into company research.

**How it works:** Parse source files, normalize records, and attach relevant employee/plan indicators. Configured employee thresholds, including the 50-employee indicator, support research; they do not establish a company-specific legal conclusion.

**Infrastructure:** Python foundation/import scripts and hosted source data.

**Evidence:** Public: scripts/foundation_form5500.py; scripts/ingest_dol5500.py; scripts/ingest_dol5500_full.py.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg08"></a>

## SG08 — SBA loan foundation

**Status:** Source present. **Purpose:** Use attributable public loan records in business growth research.

**How it works:** Import and normalize SBA records; bind evidence to the intended entity before creating useful research context. Historical financing is separate from present buying intent.

**Infrastructure:** Python foundation/import jobs, Supabase source tables.

**Evidence:** Public: scripts/foundation_sba.py; scripts/ingest_sba.py.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg09"></a>

## SG09 — SAM entity identity and opportunity discovery

**Status:** Source present. **Purpose:** Establish government-entity identity and discover supported public opportunities.

**How it works:** Use public extract/identity data and supported opportunity sources. Stable government identifiers underpin award attachment; foundation jobs are separate from the hourly rotation.

**Infrastructure:** SAM public extract scripts, entity foundation and public-growth workers.

**Evidence:** Public: scripts/foundation_sam_extract.py; tools/run-sam-entity-foundation.ps1; docs/ARCHITECTURE.md.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg10"></a>

## SG10 — USAspending prime and subaward signals

**Status:** Source present. **Purpose:** Find verified award evidence for the correct company.

**How it works:** Attach prime/subaward observations through government-entity bindings. Keep award attribution separate from similarly named recipients; the old name-only writer is retired.

**Infrastructure:** USAspending foundation, public-growth routes, entity bindings.

**Evidence:** Public: tools/run-usaspending-foundation.ps1; docs/ARCHITECTURE.md; AGENTS.md.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="sg11"></a>

## SG11 — Inc. 5000 and revenue-growth foundation

**Status:** Source present. **Purpose:** Normalize growth-list evidence into the source foundation.

**How it works:** Import the dated list, reconcile identity, preserve evidence, and make it available to external growth prioritization. A list entry does not change the raw TAM/Old Gold judgment.

**Infrastructure:** Python dated foundation job and company source records.

**Evidence:** Public: scripts/foundation_inc5000_2026.py; config/sources.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.
