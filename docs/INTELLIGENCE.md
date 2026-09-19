# Stanley intelligence

This extends Stanley's existing outbound research application. Original workstream 6 (contacts, personas, collateral matching and outreach drafts) is excluded. It does not send outreach or change TAM/Old Gold grades.

## Direct TypeSafe connection

The server calls `https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`. The default pinned model is `jev-1.13.0`; `TYPESAFE_MODEL` accepts a versioned Jev ID. Vercel hosts the application; Vercel AI Gateway and its SDK are not used. The key belongs in the existing Vercel project's Production secrets and an ignored local `.env.local`, never a `NEXT_PUBLIC_` variable.

`node tools/check-jev-connection.mjs` makes one small synthetic request. The optional full-contract live test runs only with `STANLEY_JEV_LIVE=true`; ordinary tests never call TypeSafe.

Public sources are the continuous engine's input. The authenticated `/api/agent/intelligence/evaluate` route accepts a bounded private excerpt and explicit criteria, returns annotations to the local caller, and stores only usage/cost. It never publishes a grade or retains the excerpt. `TYPESAFE_PRIVATE_EXCERPTS_ENABLED` attests that the direct-account terms have been reviewed for this authorized use. Direct TypeSafe documents no training on customer content; zero retention is an enterprise account entitlement, not a request parameter. Do not claim a Gateway retention setting applies to the direct account. Sources: https://docs.typesafe.ai/models, https://docs.typesafe.ai/legal, https://typesafe.ai/legal/data-processing.

## Collection and interpretation

The existing source rotations remain authoritative. Changed publisher articles, company pages and ATS descriptions enter `intelligence_observations`; stable source/content/context hashes reuse prior work. Site discovery follows links and sitemaps, retains successful URLs and resumes unfinished pages. ATS jobs are paginated within provider/runtime limits. Google News wrappers are recorded as unavailable article capture, not publisher body text.

Each retained public observation contains up to 48,000 characters, source/event/collection dates, exact offsets, truncation metadata and a version. Long retained text is covered in bounded Unicode-safe packets. Paid results checkpoint after each packet; resumed work reuses compatible results. The cap is explicit partial source coverage, not a claim to have read an entire longer document. Exact source URLs are canonicalized across collector kinds so a site crawl and news collection can reuse the same evidence.

Jev evaluates company relationship, event type, operating complexity and eight operating topics in one request per packet. Question contract `stanley-evidence-v2` distinguishes source-reported event dates from collection times and supplies public company background, nearby text from the same source, and bounded evidence-linked feedback examples. Background is not proof of an event. It selects supplied evidence sections; it does not write quotations, dates or contract amounts. Native answers, distributions, confidence, choice legends and model metadata are retained within explicit size bounds. These are Jev outputs, not measured accuracy or independent verification.

Eligible Jev developments publish directly through `lib/intelligence/publish.ts`. They do not enter the candidate queue or receive a second model's review. Existing feed-routing rules use the supplied event date, exact account relationship, supported event categories and Jev's scores; publication preserves Jev's judgments and a verbatim source passage. Storage readback confirms the saved result, not a new opinion about its accuracy. Existing freshness, reheat, explicit dismissal and quarantine behavior remains in place. Legacy collector candidates keep their existing independent-review path. Verified government awards retain their existing entity-bound publisher; a government announcement can enrich research without becoming a verified award. No model output changes canonical membership or grades.

Public operating hypotheses combine sourced topics and remain labeled as hypotheses. Focused research claims up to three already verified company URLs selected for missing profile topics. Durable attempts rotate toward unvisited URLs; successful or unchanged reads rest seven days, failed or empty reads one day. Profiles reload after research and while interpretation is pending.

## Continuous runtime

- `/api/cron/intelligence`: every 5 minutes; interpret up to 12 jobs and publish eligible Jev findings directly, then review up to 8 legacy candidates within the remaining function deadline.
- `/api/cron/intelligence-collect`: every 5 minutes, offset by 2 minutes; small news rotation plus alternating website/ATS rotations.
- `/api/cron/intelligence-sources`: every 15 minutes, offset by 3 minutes; shared public feeds.
- Existing hourly broad-source and federal discovery schedules remain in place.

These are polling intervals, not end-to-end latency guarantees. Publication delays, unavailable sources, queue volume and model budget can extend latency. Durable leases prevent simultaneous ownership, due times keep failed items out of the next immediate batch, and one oldest job per claim preserves backfill progress while other slots favor fresh evidence. Existing source reservations prevent this from becoming a second account coordinator.

The global switches are `STANLEY_INTELLIGENCE_ENABLED=true` and `intelligence_config.enabled=true`. Both must be enabled for new continuous processing. Apply all checked-in intelligence migrations in order first. Default configuration is disabled. Turning either switch off stops new intelligence consumption; it does not delete evidence.

## Costs and visibility

The default monthly envelope is $20, with up to $10 for Jev and $5 for the supported legacy generative verifier. Jev publication does not consume a second-model reservation. Atomic reservations count concurrent and uncertain requests. Actual usage releases unused reservations; an unknown provider outcome retains the reservation. The budget protects model dispatch, not the Vercel/Supabase bill. Monitor hosting and storage capacity separately.

The Intelligence page shows queued/running/failed work, source completeness and usage. Expandable **Jev output** shows the stored selected-packet judgments and raw answer fields alongside topic references and coverage; it is not a copy of the whole HTTP response. Triggered findings retain their source passage and Jev publication metadata. Natural-language saved questions match individual sources incrementally. Operating-topic search supports AND conditions across different sources for the same current TAM account. Account profiles retain cited context and unknowns.

Only explicit feedback supplies later examples. Wrong-company and irrelevant decisions exclude the exact observation from profile, topic and saved-view results, and exclude its associated Jev trigger; Undo restores it without rewriting the original answers. Canceled unfinished jobs retain their checkpoints. Useful, old-event and not-now feedback adjusts public priority within ±10%, softened by four neutral examples. Shared-source attention uses similarly bounded recorded outcomes and keeps an oldest-source baseline slot. No feedback action changes TAM or Old Gold grades.

## Implemented limits

An observation card gains interpretation as processing finishes, and Jev Triggered findings show their supporting passage. Different URLs reporting the same event are not yet clustered into a single event with corroborating reports. Exact-URL/content reuse is not event-level syndication detection. Account profiles currently combine eight operating topics and three explicit hypothesis templates; generated account narratives, material-change narrative updates and a dedicated contradiction/history view are not yet built. These remain separate from the working evidence search and profiles.

## Federal and TAM boundaries

Federal improvements cover supported legal/DBA/UEI search targets, multiple verified entities, continued discovery pages, prime/subaward identity binding, sequential cursor support and subaward date-window splitting. They preserve existing cursor ownership, source timeouts and exact retained readback holds. They do not execute the separately prepared federal recovery. Related-company activity appears separately with exact source-backed UEI relationships. CAGE discovery, dedicated IDV ingestion and exhaustive source coverage are not established by this release; see `FEDERAL_HISTORY_CONTINUATION.md` for exact implemented limits.

`tools/tam_evidence_index.py` prepares a lossless local navigation index from one explicitly supplied exact-record artifact. The companion `tools/tam_jev_annotations.py` can prepare or explicitly evaluate selected excerpts through the authenticated budgeted route, with versioned local annotations and an uncertain-request receipt. Neither replaces the complete reader/validator. Timing reports consume explicit compact receipts. The canonical grading runtime is paused per its latest handoff; this build does not resume it. Integration belongs at a future coordinated boundary described in `TAM_EVIDENCE_INDEX.md`. Throughput improvement has not yet been measured on live records.

## Deployment

Model reservations do not create database or hosting capacity. Monitor the existing plan's capacity and surface actual storage failures; an upgrade is not part of this implementation. Keep account balances, production table-size receipts and local credentials in private operator records. Preserve existing record/history data when resolving capacity.

Code, database migration application, Git deployment and runtime activation are separate states. A stored environment variable alone does not mean the new runtime is deployed or active. The repository contains 64 SQL files through `0062_intelligence_feedback_and_research.sql`; apply the ordered migration set, preserve service-role grants and disabled defaults, and deploy through the existing Git path. Activation enables the two runtime switches. Read back cron receipts and source-to-card results to establish actual operation.

## Validation

Run the repository Vitest suite and TypeScript checks. `scripts/tests/intelligence-migration.mjs` and its companion migration scripts cover queue/budget, shared sources, topic matching, and reversible feedback/research behavior against ephemeral PGlite installed only under ignored `work/intelligence-sql-test`; they never connect to production. They validate PostgreSQL semantics but not multi-connection lock contention. Synthetic tests do not establish actual TAM coverage, source-to-card latency or useful-lead yield; measure those during operation.

Production ships only through GitHub `armansra-hub/stanley` main and Vercel Git integration. Never use a Vercel CLI deploy. Verify the immutable deployed commit, repository, branch and Git source after any authorized release.
