# Codex review of an empty federal search capture

Migration 0148 adds one subtype to the existing `/api/agent/intelligence/news`
workflow. Claim with explicit `sourceKind: government`, one company ID, exact
`observationId`, and `observedThrough`. The default remains news.

Only retained government JSON v1 representing an empty first USAspending search
page is supported. Its request, company identity, frozen cutoff, body hash,
source key, original completeness and explicit terminal pagination must all
match. Partial, nonempty, detail, parent-dependent and unsupported sources remain
uncompleted. The same conditions are independently enforced in TypeScript and
SQL.

Read every character and all provenance. Supply the packet's `governmentCapture`
scope plus `requestIdentityConfirmed: true` and `fullProvenanceRead: true` in both
analysis and independent review. Use `no_signal`, neutral attributes, all-zero
criteria, and no passage. `identityConfirmed` means the company/query binding;
it never means a verified recipient. A different actual task must perform the
independent full read before canonical finish.

The exact event and receipt say `completionScope: source_capture`,
`historyComplete: false`, `recipientIdentityVerified: false`, and retain the
frozen `searchEndDate` and hashes. Event date stays null; trigger stays null.
This does not complete account coverage, refresh the search cutoff, advance a
federal continuation, release a hold, or authorize government publication.

The existing offline SQL harness loads production 0014 and 0059 table DDL,
including required fields, foreign keys and checks. It validates migration
replay, legacy snapshot compatibility, independent review, rollback and exact
finish receipts. An optional `STANLEY_GOVERNMENT_CAPTURE_RECEIPT` file lets it
validate a locally retained original against its captured identity; the live
claim still checks the current canonical company identity.
