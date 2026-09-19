# Where Stanley uses Jev

Reviewed September 18, 2026 (Pacific), against the checked-in implementation. This page maps actual call sites and consumers; configuration, deployed activation, and successful live outcomes remain separate facts.

Stanley uses **Jev through the direct TypeSafe API** for structured evidence interpretation and research decisions. Claude supplies chat, cited account-story writing, and the separate legacy generative classification/review path. A Jev finding does not receive a second model's review before publication, and neither public intelligence model changes TAM or Old Gold grades.

## Uses and implementation

| Use | What Jev does | Code and result |
|---|---|---|
| Public-source interpretation | Evaluates the named company's relationship to a news article, company page, supported PDF excerpt, or hiring observation; returns event, relevance, complexity, and topic judgments | [Adapter](../lib/intelligence/jev.ts), [worker](../lib/intelligence/worker.ts), [evaluation types](../lib/intelligence/evaluation.ts). Original answer fields, confidence, choice legends, source offsets and model/question versions are retained within explicit bounds. |
| Triggered findings | Supplies packet-level judgments for source-backed developments | [Publisher](../lib/intelligence/publish.ts), [events](../lib/intelligence/events.ts), [trigger evidence](../lib/intelligence/triggerEvidence.ts). Application routing applies event dates, identity, source policy, deduplication and existing review boundaries; existing source cards can receive Jev context. No second-model approval is added. |
| Operating profiles and matches | Answers bounded operating questions selected for the source and business-services subindustry | [Profiles and 21-topic taxonomy](../lib/intelligence/profiles.ts), [business-services priorities](../lib/intelligence/businessServices.ts), [topic search](../lib/intelligence/topicSearch.ts). Each packet retains its own attribution. Any/All topic matches and operating-pattern lookalikes reuse saved answers; viewing cached results does not itself require another Jev call. |
| Saved research questions | Evaluates a saved semantic question against evidence through the worker's `view` job path | [Worker request construction and result handling](../lib/intelligence/worker.ts). This is distinct from the deterministic Any/All search over cached operating topics. |
| Directed research | Ranks up to eight already discovered URL options for likely usefulness in filling explicit research gaps | [Research ranking](../lib/intelligence/researchRanking.ts), [research runner](../lib/intelligence/researchRunner.ts). Jev chooses reading order from supplied options; it does not claim to have read those pages. Unavailable, malformed or budget-deferred rankings preserve the original order. |
| Optional private TAM annotations | Evaluates bounded excerpts and explicit criteria at an authorized, already claimed record boundary | [Authenticated endpoint](../app/api/agent/intelligence/evaluate/route.ts), [local annotation helper](../operations/reference/tools/tam_jev_annotations.py), [navigation bridge](../operations/reference/tools/tam_navigation_bridge.py), [canonical runner snapshot](../operations/reference/tools/run_tam_single_record.py). The local caller owns annotation caching; the endpoint retains cost/usage, not the excerpt or grade. |

The public evidence pipeline also interprets derived ATS listing/pace observations and relevant government announcements. It does not replace the [entity-bound federal award publisher](ARCHITECTURE.md), and a government-related topic is not proof of a verified award. Similarly, a job mentioning software is not proof of a migration or completed hire.

## Connection and model roles

- The [adapter](../lib/intelligence/jev.ts) calls `https://api.typesafe.ai/v1/systemone` with server-only `TYPESAFE_API_KEY`. `TYPESAFE_MODEL` accepts a pinned versioned Jev ID; the checked-in default is `jev-1.13.0`. The adapter uses direct HTTP, so a separate Jev npm SDK or Vercel AI Gateway dependency is not required.
- Business-services requests use `stanley-business-services-v1`, with at most ten operating questions per packet. The adapter retains the public-scale and evidence-v2 contracts for their respective request shapes and compatible continuations. A 21-topic library does not mean every packet asks all 21 questions.
- [Claude account stories](../lib/intelligence/narratives.ts) turn supplied evidence and Jev judgments into cited overviews, developments, hypotheses, conflicts and unknowns. This writer does not rescore Jev or decide its trigger eligibility.
- [Chat tools](../lib/chat/run.ts) and the [legacy candidate reviewer](../lib/triggers/candidateReview.ts) remain distinct generative paths. Jev is not the outbound email/LinkedIn sender, the final full-record TAM grader, or a replacement for those existing workflow gates.

## Runtime and controls

[Vercel cron configuration](../vercel.json) schedules interpretation, baseline collection and directed research every five minutes, and shared-feed collection every fifteen minutes. Source capture, queueing, interpretation and publication are different stages; the schedule is not a guarantee of real-time coverage or successful findings.

Both the environment and database enable switches gate continuous intelligence. [Budget reservations](../lib/intelligence/budget.ts), bounded requests, durable leases, exact content/context hashes and paid-packet checkpoints constrain retries and spend. Uncertain provider outcomes retain their reservation. This documentation update makes no paid Jev requests and does not change runtime switches, model settings, budgets, schedules or grades.

Local private-excerpt evaluation additionally requires the dedicated privacy-authorization flag and current canonical workflow authorization. The TAM grader remains under its separate paused handoff; publishing its source does not resume it. The complete reader and independent complete validator remain required. See [local evidence navigation](TAM_EVIDENCE_INDEX.md) for caching, readiness probes, source pointers, fallback and readback-only recovery.

## Source and sharing status

The direct Jev adapter, application consumers, migrations, tests, and local navigation/annotation reference code are committed in this repository. The companion staging helper and reader/validator schema snapshots were refreshed from canonical local source for this handoff; the manifest records their hashes. No live ledgers, private excerpts, API keys, customer evidence, or deployment credentials are included.

For the broader library, see [Jev in Codex Automations](../codex-automations/jev-intelligence.md). For installation and source-to-result behavior, see [setup](SETUP.md), [intelligence](INTELLIGENCE.md), and [business-services research](BUSINESS_SERVICES_RESEARCH.md).
