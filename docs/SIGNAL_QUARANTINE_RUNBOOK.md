# Signal quarantine runbook

This is a bounded, non-destructive cleanup for legacy signal defects. It covers:

- finance-hire rows on record-dead companies;
- finance-hire rows where accounting, CPA, bookkeeping, payroll, or tax is the company's core business;
- fabricated homepage `#Role` evidence and invalid/unverifiable careers links;
- legacy Form D search-result URLs and strict filer/company identity mismatches; and
- the older fabricated root-anchor M&A, press, and new-entity rows.

Rows are never deleted and their evidence fields are never rewritten. Apply mode atomically adds `metadata.stanley_quarantine` with an active flag, reason, batch, actor, and timestamp. Stanley immediately excludes that marker from display and priority calculations. Each bounded call reads every marker back and recomputes the affected company priorities.

The authenticated route is `POST /api/cron/quarantine-signals`. It defaults to dry-run. Apply mode requires both:

```json
{
  "apply": true,
  "confirm": "PRESERVE_ROWS_AND_QUARANTINE"
}
```

Use at most 100 rows per call. Continue with the returned `nextCursor` while `hasMore` is true. A response with any `failures`, an HTTP 409, or `readbackVerified != planned` is not a completed page and must be investigated before continuing. Repeating an accepted page is safe: the database function marks each row once and returns no second mutation.

Career URL verification follows redirects with a 4.5-second bound and fails closed on 4xx/5xx, timeouts, or redirects away from a career/job URL. A quarantined historic job row remains available for audit even when the posting has expired.
