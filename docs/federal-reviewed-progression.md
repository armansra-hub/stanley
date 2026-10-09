# Consuming reviewed federal captures

The existing federal-discovery route can consume an already completed canonical
government source review. It does not run a provider, perform interpretation,
publish a signal, or mark a company or history complete.

1. Finish the exact retained empty first-page capture through the existing
   `intelligence_jobs` / Codex news workflow, including distinct full-source
   reader and reviewer.
2. Read `GET /api/cron/federal-discovery?inspect_reviewed_capture=<company UUID>`.
   Its `continuationSha256` uses the explicit `postgres-jsonb-text-v1` encoding.
   It is different from the sorted compact JSON hash used by pending-source
   capture admission. Never interchange these hashes.
3. Use exclusive `POST ?action=consume_reviewed_capture` with `operationId`,
   `companyId`, `expectedContinuationSha256`, `jobId`, `finishEventId`,
   `snapshotHash`, `decisionHash`, and the frozen `manualRunCutoff` date.
4. Verify the exact returned canonical event and state receipt. After an uncertain
   outcome, read back the same operation; never substitute a new operation UUID.

The transaction locks the existing source state under its existing lease. It
checks the completed job, distinct complete read attestations, exact finish event,
stored snapshot/decision hashes, current company identity, original source body
and request hashes, and the exact captured continuation. Incidental company
description or status changes do not invalidate an immutable completed review
when canonical eligibility and exact identity still hold.

The collector already advances empty contracts captures to the IDV position.
Consumption clears that capture's review gate without advancing again. A final
empty IDV position retires only that exact frozen query. A recovered terminal
capture also requires its exact canonical recovery event and retained-source
binding. Nonempty results, details, partial captures, missing originals,
unresolved writes and existing company debt remain held.

The original capacity hold stays byte-for-byte in the cursor and continues to
stop ordinary scheduled discovery. The `discoveryManualSourceOnly` marker records
its establishment event, one frozen manual-run date, and at most the four
original overflow IDs whose terminal review receipts have been consumed. Every
retired ID must have its canonical terminal event. Retirement reduces the
overflow allowance; it never increases the ordinary 1,000-position capacity.
All unrelated continuations, retry/dead-letter/strategy/readback debt, keyset,
attempt counters and cursor extensions remain unchanged.

Existing exact `continue_pending_source_only` calls can progress a remaining
position in batches of at most four. In manual source-only mode, a captured
position must have its canonical review consumed before another step. Jev and
ordinary discovery remain stopped. This release fixes the existing discovery
selector to include current TAM or canonical claimed TAL while retaining
duplicate and verified-recipient exclusions.

The coverage table receives a narrow `detail.lastReviewedSourceCapture` receipt.
An existing coverage row keeps its broader status, scope, dates and all other
detail fields. A new row is explicitly partial. The transition event retains
the full prior continuation, original hold and prior coverage row.

This release does not admit new accounts, reset `afterCompanyId`, refresh old
cutoffs or certify traversal. The remaining September 29 positions stay tied to
September 29. Bounded current-cutoff admission and refresh debt need a separately
reviewed transition after these existing receipts are consumed. Empty active
state would still not establish all-TAM source coverage.

Validation uses the actual production events, intelligence-work, federal-state
and coverage table definitions in an in-memory PostgreSQL engine. The optional
`STANLEY_FEDERAL_SAVED_EVIDENCE_DIR` replay binds four existing saved receipts by
SHA256 and synthesizes completion only inside that isolated test database. It
does not claim those production jobs were completed. The TypeScript controller
test exercises the actual SQL lease, transaction and inspection response.
