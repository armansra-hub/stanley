# Public ATS listing lifecycle

Migration `0066_intelligence_ats_lifecycle.sql` and the existing ATS sweep maintain
one durable board cursor per exact company and ATS source. The cursor includes
scan identity, offset and a revision fence. A stale overlapping invocation cannot
advance it, including when another invocation already completed a scan and reset
the offset to zero. The previous generic source-state row remains a coverage
mirror; it is no longer the authority for ATS pagination.

The sweep stores useful source observations before acknowledging their batch.
Native provider job IDs define job identity where supplied; canonical public job
URLs are the fallback. Title/location/description content defines meaningful
change. Tracking parameters, whitespace and an updated source timestamp alone do
not cause another Jev interpretation. A temporarily missing description retains
the known content hash and client-placement classification.

`intelligence_ats_jobs` preserves first/last observation times, latest title, source
URL/date, content identity, operational categories, confirmed listing presence and
the most recent transition. `intelligence_ats_scans` preserves complete-scan
counts and bounded change details. No private CRM data, TAM grades or Jev answers
are changed by this process.

The first complete scan establishes a baseline. Later complete scans distinguish
new, changed, reappearing and no-longer-listed jobs. Partial, unavailable, repeated
or inconsistent pages cannot expire jobs. Full-board APIs carry a whole-board
fingerprint across sliced processing. Paginated APIs use contiguous offsets,
distinct job identities and advertised totals where available; a repeated page,
changed total/fingerprint or final identity-count mismatch restarts a scan while
retaining the prior complete baseline. APIs without immutable snapshot tokens
cannot guarantee that their underlying listings stayed unchanged during a scan;
these are observations of a public board, not an employment ledger.

Operational categories overlap when appropriate: finance, billing, project
accounting, implementation, integration, business systems and operations.
Recruiter/client placements do not count as the recruiter's in-house role cluster.
Completed-scan summaries provide role counts, new operating-role counts, measured
new listings per day and comparison with the preceding comparable interval. A
rate is reported only when the interval spans at least a day. Initial inventory
is not called new hiring, and a removed listing is not called a filled vacancy.

Three new or reappearing operating roles across at least two categories produce
a hiring-pattern observation. A measured pace increase of at least two times with
at least three new listings can also produce one. The source is the actual public
board endpoint; the retained passage states its two scan times, listing counts,
job links and the distinction between listing activity and actual hires. Jev
interprets this additional evidence through the normal direct-output path.

Pattern work remains pending on the completed scan until the existing observation
function acknowledges its effect. The next normal sweep handles at most three
pending scans per board. A lost response can reuse the existing observation's
identity without inventing another queue, model reviewer or job identity.

`readAtsHiringContext(companyId)` in `lib/intelligence/atsLifecycle.ts` returns
cache-only board health, the latest 20 completed scans and an explanatory basis
for account profiles. A missing baseline stays explicit. Historical timestamps
are source dates or local observation dates as labeled; neither implies when a
person was actually hired.

Validation: 33 focused TypeScript tests cover normalization, pagination,
classification, meaningful-change suppression and sweep ordering; 19 synthetic
in-memory PostgreSQL cases execute the actual migration/function through partial,
unavailable, complete, drifted, expired, reopened and overlapping scan scenarios.
The SQL receipt is `work/ats-lifecycle-sql-receipt.json`. These checks establish
implementation behavior; live listing pace requires multiple completed scans.
