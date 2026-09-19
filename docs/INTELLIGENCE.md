# Stanley intelligence

This extends Stanley's existing outbound research application. Original workstream 6 (contacts, personas, collateral matching and outreach drafts) is excluded. It does not send outreach or change TAM/Old Gold grades.

This document describes the checked-in implementation through migrations 0063–0068. It does not assert that a particular production database has those migrations, that the matching Git deployment is live, or that the operating targets have been achieved. Production receipts establish those separate facts.

## Direct TypeSafe connection

The server calls `https://api.typesafe.ai/v1/systemone` with `TYPESAFE_API_KEY`. The default pinned model is `jev-1.13.0`; `TYPESAFE_MODEL` accepts a versioned Jev ID. Vercel hosts the application; Vercel AI Gateway and its SDK are not used. The key belongs in the existing Vercel project's Production secrets and an ignored local `.env.local`, never a `NEXT_PUBLIC_` variable.

`node tools/check-jev-connection.mjs` makes one small synthetic request. The optional full-contract live test runs only with `STANLEY_JEV_LIVE=true`; ordinary tests never call TypeSafe.

Public sources are the continuous engine's input. The authenticated `/api/agent/intelligence/evaluate` route accepts a bounded private excerpt and explicit criteria, returns annotations to the local caller, and stores only usage/cost. It never publishes a grade or retains the excerpt. `TYPESAFE_PRIVATE_EXCERPTS_ENABLED` attests that the direct-account terms have been reviewed for this authorized use. Direct TypeSafe documents no training on customer content; zero retention is an enterprise account entitlement, not a request parameter. Do not claim a Gateway retention setting applies to the direct account. Sources: https://docs.typesafe.ai/models, https://docs.typesafe.ai/legal, https://typesafe.ai/legal/data-processing.

## Collection and interpretation

The existing source rotations remain authoritative. Changed publisher articles, company pages and ATS descriptions enter `intelligence_observations`; stable source/content/context hashes reuse prior work. Site discovery follows links and sitemaps, retains successful URLs and resumes unfinished pages. Google News wrappers are recorded as unavailable article capture, not publisher body text.

ATS collection now retains one resumable board cursor, listing identities and complete-scan history. Completed scans distinguish new, changed, reappearing and no-longer-listed jobs; incomplete scans cannot expire listings. Overlapping finance, billing, project accounting, implementation, integration, business-systems and operations categories expose useful hiring clusters. Derived cluster and comparable pace-change observations enter the normal Jev interpretation path. Initial inventory is a baseline, and a removed listing does not establish a completed hire. Cached hiring context appears on the account profile. See [ATS listing lifecycle](ATS_LIFECYCLE.md) for provider limits, ownership and measurement semantics.

Shared feeds include GSA and Washington Commerce, plus California GO-Biz/Governor, Texas Governor/Comptroller, FreightWaves and PR Newswire general-business and media categories. The California/Texas selections use the observed TAM concentration and verified free feeds. Each source stores its coverage description. These are announcement/reporting sources; they do not claim complete state/local contract histories. Feed downloads are shared across plausible account matches, and canonical source identity reuses overlapping articles.

Each retained public observation contains up to 48,000 characters, source/event/collection dates, exact offsets, truncation metadata and a version. Long retained text is covered in bounded Unicode-safe packets. Paid results checkpoint after each packet; resumed work reuses compatible results. The cap is explicit partial source coverage, not a claim to have read an entire longer document. Exact source URLs are canonicalized across collector kinds so a site crawl and news collection can reuse the same evidence.

Jev evaluates company relationship, event type, operating complexity and eight operating topics in one request per packet. Question contract `stanley-evidence-v2` distinguishes source-reported event dates from collection times and supplies public company background, nearby text from the same source, and bounded evidence-linked feedback examples. Background is not proof of an event. It selects supplied evidence sections; it does not write quotations, dates or contract amounts. Native answers, distributions, confidence, choice legends and model metadata are retained within explicit size bounds. These are Jev outputs, not measured accuracy or independent verification.

Eligible Jev developments publish directly through `lib/intelligence/publish.ts`. They do not enter the candidate queue or receive a second model's review. Existing feed-routing rules use the supplied event date, exact account relationship, supported event categories and Jev's scores; publication preserves Jev's judgments and a verbatim source passage. Storage readback confirms the saved result, not a new opinion about its accuracy. Existing freshness, reheat, explicit dismissal and quarantine behavior remains in place. Legacy collector candidates keep their existing independent-review path. Verified government awards retain their existing entity-bound publisher; a government announcement can enrich research without becoming a verified award. No model output changes canonical membership or grades.

## Events, account stories and discovery

Public operating profiles combine eight independently supported topics: multiple entities, project/contract accounting, recurring revenue, inventory, multiple locations, systems change, acquisition integration and government work. Exact source passages support each topic; unknowns stay explicit. Combined topics can suggest a testable operating hypothesis without claiming confirmed pain, buying intent or a grade change.

`lib/intelligence/events.ts` and migration 0063 group qualifying reports into durable account events. Grouping uses the same exact account/type, nearby source dates and discriminating headline tokens; exact source revisions retain their source history. Cross-URL matching requires dates within three days and either an exact signature of at least three words or at least four words with 80% overlap. Ambiguous paraphrases remain separate. Per-account locking and a unique trigger event key prevent simultaneous syndicated reports from publishing duplicate event cards. A trigger retains the actual report URL, passage and original Jev finding that published it; later reports enrich the same event's source list. Multiple URLs are additional reports, not a claim of independent corroboration.

`lib/intelligence/narratives.ts` writes sourced account stories automatically for promising developments/compound operating context, or on demand through `/api/headhunter/intelligence/story`. This uses the existing generative model for writing only; it does not review, rescore or approve Jev's findings. Stories separate an overview, developments, explicitly unverified operational hypotheses, conflicting source claims and unknowns. Citation IDs bind to supplied public observations. An explicit contradiction needs two distinct sources; an absent topic or low Jev score is not treated as contradictory evidence.

Stories read up to 80 current and 40 historical observations, select bounded excerpts within a 14,000-byte request envelope, and disclose included/available source counts and truncation. Material evidence/context hashes coalesce work and reuse existing versions. A transactionally persisted dirty marker survives a worker disappearing after interpretation; generation results checkpoint under the exact live lease. Stale work cannot replace a newer version. History remains stored, while the UI displays the latest eight story versions and dated source history. Feedback-excluded sources invalidate affected displayed stories without rewriting Jev's answers or deleting prior versions.

Natural-language saved questions evaluate matching evidence incrementally. Operating-topic searches combine supported topics across different sources for the same account. Operating-pattern lookalikes use cached topic overlap across current canonical TAM accounts and return supporting sources; similarity describes operating traits, not buying probability. No additional model request is needed for cached topics, lookalikes or profile reads.

## Directed research

Manual profile refresh and `runDirectedResearchWorker` share `lib/intelligence/researchRunner.ts`. They use the same already discovered, same-company URLs and the existing `intelligence_research_attempts` claim/finish functions. Up to three URLs are claimed per account turn. Successful or unchanged reads rest seven days; failed or empty reads rest one day. A source fetch failure stays distinct from an empty source, and an unconfirmed observation write is not reported as an unchanged success.

Jev ranks up to eight supplied URL options in one budgeted call using the account identity and explicit missing-topic context. This selects the next useful page to read; it does not reinterpret an existing finding or pretend the unvisited page has been read. Native ranking answers, confidence and usage remain in the POST response and event receipt. The unranked tail remains available. Ties preserve prior order; unavailable Jev, exhausted model budget or malformed input/output preserves the entire original order so ordinary research can continue.

Migration 0067 supplies coalesced automatic account wakeups for promising interpreted evidence with research gaps, and for newly discovered source links. Meaningful evidence changes replace the work version; unchanged inputs preserve the current lease or defer time. The account queue coordinates wakeups only: exact source ownership stays in the existing per-URL attempts table, shared with the manual action. Workers require at least 40 seconds remaining before claiming, persist outcomes and native ranking, back off service failures and defer until URLs are due. Fully supported topics stop automatic gap research. Profile GET remains cache-only and includes current hiring context.

## Continuous runtime

- `/api/cron/intelligence`: every 5 minutes. Within the invocation's elapsed-time budget, interpret up to 192 jobs before 190 seconds, process up to two directed-research accounts before 240 seconds, write up to two account stories before 275 seconds, and review up to eight legacy candidates before 285 seconds. Each stage also honors its own minimum remaining time; these are ceilings, not guaranteed completed batch counts.
- `/api/cron/intelligence-collect`: every 5 minutes, offset by 2 minutes. A 30-account news rotation runs alongside a three-slot rotation of up to 48 claimable website accounts, 72 ATS accounts or 48 tail website accounts.
- `/api/cron/intelligence-sources`: every 15 minutes, offset by 3 minutes. Process at most ten shared sources and eight pending articles per source within a 210-second collection budget, retaining unfinished work.
- Successful collection/shared-source invocations wake up to 96 interpretation jobs immediately within the original invocation's remaining 280-second budget. Observations are already durable; the scheduled worker recovers if an immediate wakeup does not run or stops early.
- Existing hourly broad-source and federal discovery schedules remain in place.

These are polling intervals, not end-to-end latency guarantees. Publication delays, unavailable sources, queue volume and model budget can extend latency. Durable leases prevent simultaneous ownership, due times keep failed items out of the next immediate batch, and one oldest job per claim preserves backfill progress while other slots favor fresh evidence. Existing source reservations prevent this from becoming a second account coordinator.

The global switches are `STANLEY_INTELLIGENCE_ENABLED=true` and `intelligence_config.enabled=true`. Both must be enabled for new continuous processing. Apply all checked-in intelligence migrations in order first. Default configuration is disabled. Turning either switch off stops new intelligence consumption; it does not delete evidence.

## Costs and visibility

The default monthly envelope is $20, with up to $10 for Jev and $5 shared by account-story writing and the supported legacy generative verifier. Jev publication does not consume a second-model reservation. Research-option ranking uses the Jev budget. Atomic reservations count concurrent and uncertain requests. Actual usage releases unused reservations; an unknown provider outcome retains the reservation. The account writer uses pinned Haiku 4.5, a bounded request and 1,200 output-token limit within the existing $0.03 generation reservation. The budget protects model dispatch, not the Vercel/Supabase bill. Monitor hosting and storage capacity separately.

The Intelligence page shows queued/running/failed work, source completeness and usage. Expandable **Jev output** shows the stored selected-packet judgments and raw answer fields alongside topic references and coverage; it is not a copy of the whole HTTP response. Triggered findings retain their source passage, event reports and Jev publication metadata. Account research shows stories, conflicting claims, history, profile topics, hiring context and sourced lookalikes.

Migration 0065 adds runtime health measurements: due/deferred work, expired leases, recent completion counts, median/p95 capture-to-interpretation time, capture-to-card time, current-TAM evidence coverage, successful 48-hour website/ATS coverage, distinct Jev-triggered accounts, explicit useful feedback and model spend. These expose operation; a source attempt is not a successful capture, a trigger count is not confirmed sales quality, and a provider announcement date is not guaranteed first-public-availability time.

Only explicit feedback supplies later examples. Wrong-company and irrelevant decisions exclude the exact observation from profile, topic and saved-view results, and exclude its associated Jev trigger; Undo restores it without rewriting the original answers. Canceled unfinished jobs retain their checkpoints. Useful, old-event and not-now feedback adjusts public priority within ±10%, softened by four neutral examples. Shared-source attention uses similarly bounded recorded outcomes and keeps an oldest-source baseline slot. No feedback action changes TAM or Old Gold grades.

## Federal and TAM boundaries

Federal improvements cover supported legal/DBA/UEI/CAGE discovery, multiple verified recipients, source-specific coverage receipts, resumable prime and subaward history, sequential cursors and subaward date-window splitting. Prime history and first-recipient discovery also search the separate IDV collection. Direct contract actions, vehicle/parent links and source-reported performance, option and ordering dates remain distinct; a vehicle ceiling is not treated as realized revenue. Related-company activity remains separately labeled and outside direct totals. SAM API access still requires its configured key. Existing cursor owners, source limits and retained identity/readback holds remain authoritative; deploying code does not itself release a held source. See [Federal history continuation boundaries](FEDERAL_HISTORY_CONTINUATION.md) for implemented lifecycle details, source scope, provider evidence and remaining coverage limits.

Local TAM navigation is installed in the canonical single-record runner at its paused, drained boundary. `tools/tam_navigation_bridge.py` reuses complete record/PDF-text evidence, builds lossless exact-ID indexes and supplies original source pointers to both existing complete reads. Preparation failures fall back to the existing full evidence. Eligible completed reader artifacts retain their reuse path; accepted-publication recovery stays readback-only. Versioned Jev request files prepare bounded excerpts locally; only explicit annotation evaluation transmits them through the authenticated budgeted endpoint. Completed raw annotations can be reused without another model review.

The canonical grader remains paused under its separate handoff. Installation does not claim a record, resume a scheduler, publish a grade or change ownership. One offline exact-record benchmark measured about 419 ms fresh navigation preparation versus about 13 ms cached preparation, saving roughly 0.41 seconds for that stage; it does not establish an equivalent grading-speed multiplier. Stage receipts now measure the canonical runner's preparation, reading, validation, staging and publication. Live grades/hour, useful-lead gains and end-to-end latency improvement remain unmeasured until operational receipts establish them. See [Local TAM evidence navigation](TAM_EVIDENCE_INDEX.md).

## Deployment

Model reservations do not create database or hosting capacity. Monitor the existing plan's capacity and surface actual storage failures; an upgrade is not part of this implementation. Keep account balances, production table-size receipts and local credentials in private operator records. Preserve existing record/history data when resolving capacity.

Code, database migration application, Git deployment and runtime activation are separate states. A stored environment variable alone does not mean the new runtime is deployed or active. Apply the ordered migration set by full basename, preserve service-role grants and existing enable choices, and deploy through the existing Git path. The expansion after the 0059–0062 foundation is:

| Migration | Behavior |
|---|---|
| `0063_intelligence_event_stories.sql` | Event grouping, progressive source lists, unique event publication, durable story writing and versions. |
| `0064_federal_source_coverage.sql` | Explicit per-company federal source coverage. |
| `0065_intelligence_runtime_metrics.sql` | Measured runtime health and sourced operating-pattern lookalikes. |
| `0066_intelligence_ats_lifecycle.sql` | Resumable board scans and retained listing/change history. |
| `0067_intelligence_directed_research_queue.sql` | Automatic coalesced missing-topic research using existing source leases. |
| `0068_intelligence_regional_industry_sources.sql` | Verified free regional/industry feeds with explicit source coverage descriptions. |

Activation requires the two runtime switches. Read back the exact deployed Git source, migration application, cron receipts and source-to-card results to establish actual operation. Source access, provider omissions, bounded requests, fiscal budgets and hosting capacity remain visible constraints; the presence of all features is not evidence of exhaustive account or contracting coverage.

## Validation

Run the repository Vitest suite and TypeScript checks. The `scripts/tests/intelligence-*-migration.mjs` scripts cover queue/budget, shared sources, topics, feedback, event/story ownership and directed research against ephemeral PGlite installed only under ignored `work/intelligence-sql-test`; they never connect to production. ATS and federal suites cover their own continuation, source-identity and lifecycle cases. These checks validate implementation behavior and PostgreSQL semantics, not production multi-connection lock contention or guaranteed provider coverage. Synthetic tests do not establish actual TAM rotation, source-to-card latency or useful-lead yield; measure those during operation.

Production ships only through GitHub `armansra-hub/stanley` main and Vercel Git integration. Never use a Vercel CLI deploy. Verify the immutable deployed commit, repository, branch and Git source after any authorized release.
