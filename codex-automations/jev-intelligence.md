# Jev intelligence and research

[Catalog home](README.md) · [Jev usage and code map](../docs/JEV_USAGE.md)

Added September 18, 2026 (Pacific). These are components of Stanley, not six separate deployments. Source presence does not establish current runtime activation or measured results.

<a id="jv01"></a>

## JV01 — Direct Jev interpretation and trigger publication

**Status:** Source present. **Purpose:** Interpret public company evidence while preserving native judgments.

**How it works:** One direct TypeSafe request per bounded packet returns relationship, event, complexity and operating judgments. Native answers and source passages are retained. Eligible developments publish directly or attach to existing cards; application routing and source deduplication do not add a second model review.

**Infrastructure:** Server-only direct HTTP adapter; default pinned jev-1.13.0; durable worker, publisher and event tables.

**Evidence:** Public: lib/intelligence/jev.ts; worker.ts; publish.ts; events.ts; docs/JEV_USAGE.md.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.

<a id="jv02"></a>

## JV02 — Jev operating profiles, saved questions and matching

**Status:** Source present. **Purpose:** Make source-supported operating context searchable across accounts.

**How it works:** Business-services interpretation selects at most ten operating questions per packet from a 21-topic library. Every packet retains its own attribution. Saved semantic questions use the worker view path; Any/All topic matching, profiles and lookalikes reuse cached results without another model call. Traits and hypotheses are not confirmed pain or buying intent.

**Infrastructure:** Jev worker, operating profiles, topic cache/search, inline account UI, Supabase.

**Evidence:** Public: lib/intelligence/profiles.ts; businessServices.ts; topicSearch.ts; worker.ts.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.

<a id="jv03"></a>

## JV03 — Jev-directed research and source ranking

**Status:** Source present. **Purpose:** Choose useful next pages without confusing unvisited URLs with evidence.

**How it works:** Rank up to eight discovered same-company options against explicit missing-topic context. Retain the unranked tail and original order on errors or budget deferral. A separate five-minute research worker claims up to three sources per account, sharing source leases with manual research.

**Infrastructure:** Jev ranking adapter; researchRunner; discovered-source queue; bounded web/PDF readers.

**Evidence:** Public: lib/intelligence/researchRanking.ts; researchRunner.ts; app/api/cron/intelligence-research/route.ts.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.

<a id="jv04"></a>

## JV04 — Jev evidence feeding Claude account stories

**Status:** Source present. **Purpose:** Turn retained evidence into source-cited account memory.

**How it works:** Jev supplies structured findings; Claude writes an overview, developments, explicitly unverified hypotheses, conflicting source claims and unknowns. The writer neither approves nor rescores Jev. Event grouping and versioned stories retain source history; syndicated reports are not automatically independent corroboration.

**Infrastructure:** Jev interpretations plus existing Anthropic account writer; durable story jobs and versioned storage.

**Evidence:** Public: lib/intelligence/narratives.ts; events.ts; docs/INTELLIGENCE.md.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.

<a id="jv05"></a>

## JV05 — Optional local Jev TAM evidence annotations

**Status:** Source present. **Purpose:** Assist evidence navigation at a separately authorized full-record review boundary.

**How it works:** Local indexes preserve full source pointers; bounded excerpt packets can be sent through an authenticated privacy-gated endpoint after readiness checks. Completed annotations are cached locally and uncertain paid attempts are not replayed. Full reader and independent validator remain required. The grader is separately paused; publication of this code does not activate it.

**Infrastructure:** Python navigation/annotation helpers; authenticated agent endpoint; shared Jev budget; private local cache.

**Evidence:** Public: operations/reference/tools/tam_jev_annotations.py; tam_navigation_bridge.py; run_tam_single_record.py; app/api/agent/intelligence/evaluate/route.ts; docs/TAM_EVIDENCE_INDEX.md.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.

<a id="jv06"></a>

## JV06 — Jev budget, checkpoints, feedback and runtime visibility

**Status:** Source present. **Purpose:** Keep continuous interpretation bounded and recoverable.

**How it works:** Atomic reservations, exact content/context hashes, leases and paid-packet checkpoints constrain dispatch and retries. Unknown outcomes retain reservations. Explicit feedback can exclude evidence or adjust bounded public priority without rewriting native answers or CRM grades. Metrics distinguish source capture, interpretation, queue latency and published cards.

**Infrastructure:** TypeSafe requests; Supabase queue/budget/feedback/metrics; Vercel five/fifteen-minute schedules.

**Evidence:** Public: lib/intelligence/budget.ts; observations.ts; feedback.ts; worker.ts; vercel.json; docs/INTELLIGENCE.md.

**Sharing:** Implementation and reviewed reference code are public; operation requires authorized configuration and private state.
