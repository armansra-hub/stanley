# Partnered with Oracle

`oracle_partnership` records a dated partnership, alliance, joint initiative or
Oracle PartnerNetwork membership between the exact account and Oracle Corporation.
It appears as **Partnered with Oracle** in Triggered and its signal filter. It is
relationship context: it does not establish ERP pain, purchase intent, budget or
Oracle/NetSuite product use, and never changes TAM or Old Gold grades.

This implementation is local and inactive. No company search, source collection,
Jev call, sweep, schedule, live migration or deployment was run to build it. The user's
LevelTen example motivates the category; this change does not verify that company
or seed a finding about it.

## Exact source-only discovery

`oraclePartnershipSearchPlan({name, domain})` is a pure, bounded query planner. It
returns company-specific Google News and LinkedIn queries, retaining the company
name and an optional supplied domain. It neither enumerates accounts nor performs
I/O. An authorized run must use canonical current TAM selection and preserve independent
claimed TAL membership; it must not create a parallel account list.

The existing `fetchNewsForCompanyResult` adapter accepts explicit
`{topic: "oracle_partnership"}` and reuses its cache, HTTP safety, date handling
and bounded retrieval. The existing `/api/cron/triggers` route accepts
`topic=oracle_partnership&sourceOnly=1&companyIds=<exact UUIDs>&runCutoff=<frozen UTC>`.
Both the route and collector require that finite scope. The same reservation RPC
reloads current company identity and admits current TAM **or** canonical claimed
TAL, including TAL removed from TAM; duplicate history remains excluded. It uses
`news:oracle_partnership` in the existing source-state table for independent
reservation, cache, pending bodies and attempt cutoff. It never stamps general
news completion, runs executive-hire discovery, or changes scheduled query topics.
Collection results certify reservation and collector outcomes only; an empty
feed does not certify absence of a partnership or complete independent review.

LinkedIn
queries are for supervised discovery in the existing authenticated Chrome session;
this adds no scraper, browser automation or outreach. News sources found there can
use the existing source-capture/review path. A LinkedIn-only post needs a complete,
provenance-preserving capture admitted by that path; a search URL/snippet or a
relabelled screenshot cannot be submitted as an original news article.

## Evidence and review

Require the complete original source, exact account identity, Oracle as the actual
counterparty, the relationship, source URL, original passage and source-reported
event date. Preserve publication and retrieval times separately. Existing date,
identity, full-read, independent Codex reviewer, deduplication and exact completion
readback gates remain. The new category requires `companyRole: "partner"` and
`contentClass: "actual_company_development"`; the selected passage must name Oracle
and a partnership/actual collaboration. The passage check is necessary syntax,
not a substitute for semantic review of both parties, negation and chronology.

Classification is prepared in the existing Codex review contract. Paid Jev
question packs remain unchanged; no new paid analysis is enabled or required.

Oracle software use, a customer/vendor logo, a job requiring Oracle skills, a
former Oracle employee, a partnership with someone who is merely an Oracle
partner, sponsorship and shared-name matches do not qualify. Undated directories
and old announcements remain context rather than fresh events. Empty searches,
unavailable pages and missing original bodies are not completed negative findings.

## Release boundary

Migration `0150_oracle_partnership_signal.sql` narrowly extends the existing
canonical reviewed publisher allowlist and enforces the new category's attribution
and passage requirements. It also extends the existing finite reservation RPC
with the independent Oracle source key, using company-row locks and the same
immutable-cutoff/hourly attempt fence. It adds no table, queue or scheduled caller.
Apply the guarded release package only after exact catalog and ledger preflight;
an unknown execution outcome requires read-only reconciliation before any replay.
All other publisher logic, grants and policies remain intact. Apply it after pending
0148/0149 migrations and verify the function before any later app release. No
database write, application deployment or execution is authorized by merely
building this change. Jev and the deleted reminder remain paused/deleted.
