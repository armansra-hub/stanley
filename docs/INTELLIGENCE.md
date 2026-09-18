# Stanley intelligence

This extends Stanley's existing outbound research application. Original workstream 6 (contacts, personas, collateral matching and outreach drafts) is excluded. It does not send outreach or change TAM/Old Gold grades.

## Direct TypeSafe connection

The server calls `https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`. The default pinned model is `jev-1.13.0`; `TYPESAFE_MODEL` accepts a versioned Jev ID. Vercel hosts the application; Vercel AI Gateway and its SDK are not used. The key belongs in the existing Vercel project's Production secrets and an ignored local `.env.local`, never a `NEXT_PUBLIC_` variable.

`node tools/check-jev-connection.mjs` makes one small synthetic request. The optional full-contract live test runs only with `STANLEY_JEV_LIVE=true`; ordinary tests never call TypeSafe.

Public sources are the continuous engine's input. The authenticated `/api/agent/intelligence/evaluate` route accepts a bounded private excerpt and explicit criteria, returns annotations to the local caller, and stores only usage/cost. It never publishes a grade or retains the excerpt. `TYPESAFE_PRIVATE_EXCERPTS_ENABLED` attests that the direct-account terms have been reviewed for this authorized use. Direct TypeSafe documents no training on customer content; zero retention is an enterprise account entitlement, not a request parameter. Do not claim a Gateway retention setting applies to the direct account. Sources: https://docs.typesafe.ai/models, https://docs.typesafe.ai/legal, https://typesafe.ai/legal/data-processing.

## Collection and interpretation

The existing source rotations remain authoritative. Changed publisher articles, company pages and ATS descriptions enter `intelligence_observations`; stable source/content/context hashes reuse prior work. Site discovery follows links and sitemaps, retains successful URLs and resumes unfinished pages. ATS jobs are paginated within provider/runtime limits. Google News wrappers are recorded as unavailable article capture, not publisher body text.

Each retained public observation contains up to48,000 characters, source/event/collection dates, exact offsets, truncation metadata and a version. Long retained text is covered in bounded Unicode-safe packets. Paid results checkpoint after each packet; resumed work reuses them. The cap is explicit partial source coverage, not a claim to have read an entire longer document.

Jev evaluates company relationship, event type, operating complexity and eight operating topics in one request per packet. It selects supplied evidence sections; it does not write quotations, dates or contract amounts. Public operating hypotheses combine supported topics and remain unverified. Focused research refreshes up to three already verified company URLs selected for missing profile topics.

Eligible dated developments join the existing candidate queue. The independent evidence verifier remains the publication authority. Verified government awards retain their existing entity-bound publisher. A government announcement can enrich research without becoming a verified award. No model output changes canonical membership or grades.

## Continuous runtime

- `/api/cron/intelligence`: every5 minutes; interpret up to12 jobs, then review up to8 candidates within the remaining function deadline.
- `/api/cron/intelligence-collect`: every5 minutes, offset by2 minutes; small news rotation plus alternating website/ATS rotations.
- `/api/cron/intelligence-sources`: every15 minutes, offset by3 minutes; shared public feeds.
- Existing hourly broad-source and federal discovery schedules remain in place.

These are polling intervals, not end-to-end latency guarantees. Publication delays, unavailable sources, queue volume and model budget can extend latency. Durable leases prevent simultaneous ownership, due times keep failed items out of the next immediate batch, and one oldest job per claim preserves backfill progress while other slots favor fresh evidence. Existing source reservations prevent this from becoming a second account coordinator.

The global switches are `STANLEY_INTELLIGENCE_ENABLED=true` and `intelligence_config.enabled=true`. Both must be enabled for new continuous processing. Apply all checked-in intelligence migrations in order first. Default configuration is disabled. Turning either switch off stops new intelligence consumption; it does not delete evidence.

## Costs and visibility

The default monthly envelope is $20, with up to$10 for Jev and $5 for the supported generative verifier. Atomic reservations count concurrent and uncertain requests. Actual usage releases unused reservations; an unknown provider outcome retains the reservation. The budget protects model dispatch, not the Vercel/Supabase bill. Hosting/storage needs separate capacity checks.

The Intelligence page shows queued/running/failed work, source completeness and usage. Natural-language saved questions scan evidence incrementally. Account operating profiles retain cited context and unknowns. Operating-topic search uses cached evidence across sources. Feedback reasons stay distinct, and only explicit feedback supplies later correction examples.

## Federal and TAM boundaries

Federal improvements cover supported legal/DBA/UEI search targets, multiple verified entities, continued discovery pages, prime/subaward identity binding, subaward date-window splitting and malformed-response handling. They preserve existing cursor ownership, source timeouts and exact retained readback holds. They do not execute the separately prepared federal recovery. Related-company activity appears separately with exact source-backed UEI relationships. Prime/discovery sequential cursor support, CAGE discovery, dedicated IDV ingestion and exhaustive source coverage are not established by this release; see `FEDERAL_HISTORY_CONTINUATION.md` for exact implemented limits.

`tools/tam_evidence_index.py` prepares a lossless local navigation index from one explicitly supplied exact-record artifact. The companion `tools/tam_jev_annotations.py` can prepare or explicitly evaluate selected excerpts through the authenticated budgeted route, with versioned local annotations and an uncertain-request receipt. Neither replaces the complete reader/validator. Timing reports consume explicit compact receipts. The canonical grading runtime is paused per its latest handoff; this build does not resume it. Integration belongs at a future coordinated boundary described in `TAM_EVIDENCE_INDEX.md`. Throughput improvement has not yet been measured on live records.

## Deployment

Confirm existing database and hosting headroom before activation; model reservations do not create storage capacity. Keep account balances, production table-size receipts and local credentials in private operator records. Preserve existing record/history data when resolving capacity.

Code, database migration application, Git deployment and runtime activation are separate states. A stored environment variable alone does not mean the new runtime is deployed or active. Apply the intelligence migrations in order, verify service-role grants and disabled defaults, deploy through the existing Git path, then enable a bounded rollout after capacity is established. Read back the cron receipts and source-to-card results before expanding collection.

## Validation

Run the repository Vitest suite and TypeScript checks. `scripts/tests/intelligence-migration.mjs` runs the queue/budget migration against ephemeral PGlite installed only under ignored `work/intelligence-sql-test`; it never connects to production. It validates PostgreSQL semantics but not multi-connection lock contention. Synthetic tests do not establish actual TAM coverage, source-to-card latency or useful-lead yield; measure those after bounded activation.

Production ships only through GitHub `armansra-hub/stanley` main and Vercel Git integration. Never use a Vercel CLI deploy. Verify the immutable deployed commit, repository, branch and Git source after any authorized release.
