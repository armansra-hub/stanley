# Existing news route: external discovery receipts

`POST /api/agent/intelligence/news` accepts source-only actions under the
existing agent-token authentication and `x-agent-name: codex` header. All require
a durable UUID `requestId`, actual `taskId`, exact `companyId`, `sourceOnly: true`
and `expectedIdentity: {name, domain, netsuiteInternalId}` matching the current
canonical account. Scope is current TAM or canonical claimed TAL, excluding
duplicate identity records. Migration `0152_external_news_receipt_intake.sql`
must be applied before these actions are used.

- `import_discovery`: supply `lane` (`news` or `oracle_partnership`), `retrievedAt`,
  and the exact public JSON strings `providerRequest` and `providerResponse`,
  with their UTF-8 `requestSha256` and `responseSha256`. Supports successful
  `tinyfish.web.search` / `tinyfish.web.search.news` responses, including the MCP
  `structuredContent` envelope, with at most 24 results. No search is dispatched.
  The receipt, existing external-query ledger, discovered sources and separately
  keyed source state commit atomically. Empty pages remain explicit query-page
  results; pagination is unknown and `complete`, analysis and account completion
  are never asserted. Raw provider dates remain raw, with no invented event date.
  Search-gateway URLs remain in the immutable result but are non-capturable and
  are not inserted into the fetchable research-source ledger. The receipt reports
  `capturableResultCount` separately from the full returned `sourceCount`.
- `capture_discovery_url`: supply the imported `discoveryId` and exact result
  `position`. The existing research URL lease and operation receipt commit before
  the one direct public-original fetch. Complete originals enter the existing
  `intelligence_observe` / interpret-job path; no classifier or publisher runs.
  Existing current observations and previously attempted/held URLs are preserved.
  Failed, truncated or oversized bodies are explicit holds, without substituting
  a headline as a complete original.
- `import_retained_http` (requires migration `0153_retained_http_article_intake.sql`):
  import one authentic already saved public HTML response for an exact existing
  news observation. Supply `observationId`, its `expectedContentHash`, and a
  strict `receipt`: `sourceKind: "retained_http"`, actual `attestorTaskId` equal
  to `taskId`, identical canonical `requestedUrl`/`finalUrl`, actual `fetchedAt`,
  `status: 200`, `redirectCount: 0`, `completeResponse: true`, allowlisted
  `headers` (`content-type`, optional `date`, `last-modified`, `etag`), and
  `bodyBase64`, `bodyBytes`, `bodySha256`. These are exact saved decoded HTTP
  response bytes, at most 180 KB, encoded as canonical base64 with SHA-256.
  UTF-8 HTML only; malformed bytes, NUL/unpaired-surrogate strings, blocked,
  incomplete, oversized or redirected responses are rejected whole. No fetch
  occurs. The server extracts text, sections, identity and original date metadata;
  no caller text/event-date override is accepted. `observedAt` is the saved fetch
  time, never import time. Raw bytes remain in the immutable intake operation.
  Hashes prove integrity, not independent network authenticity; the receipt
  explicitly preserves the authenticated attestor and that limitation.
  SQL locks/rechecks current account/source identity, URL and hash, and refuses
  to replace claimed, uncertain, held, interpreted or completed work. An identical
  complete current body can be acknowledged without altering its jobs. Otherwise
  only an unreviewed, explicitly incomplete current original may receive a new
  canonical observation/job. Old bodies, dates, jobs and provider-failure ledgers
  remain unchanged; only normal source-version currentness advances. The exact
  operation is atomic/idempotent and supports the same `intakeId` readback.

A single non-future `published` timestamp extracted from the original is retained
as `eventDate` with `page_publication` provenance. Conflicting, missing, modified
or generic time values cannot supply it. SQL checks the same date binding before
canonical capture. The original's complete source-date metadata remains available
to the independent reviewer; provider-relative labels never supply a date.

The whole request is bounded to 256 KB; import strings are separately bounded.
Only public receipt data belongs here: provider credentials are rejected.
Google failures, membership, grades and prior findings remain unchanged.
Existing discovery triggers may wake the existing directed-research scheduler;
this route does not run it, alter the Jev pause, or spend a model budget.

Use `GET /api/agent/intelligence/news?intakeId=<requestId>` for exact read-only
recovery. Keep the same operation UUID and exact payload. An identical import or
capture request returns its existing receipt; an uncertain capture never
refetches, even after its lease expires. A provider call ID can be imported only
once. A changed payload, changed account identity, existing query lease or
uncertain prior URL attempt fails closed. Never invent a replacement UUID to
bypass an unresolved request. External/manual uncertainty that predates this
ledger must remain in the caller's exclusion set until independently reconciled.

The returned capture `observationId` is only a source nomination. Normal current
job, full-original, independent-review, live-trigger dedupe and canonical finish
gates still apply. No source import promotes frozen-sweep or whole-account
coverage. The discovery-fetch path does not claim retained original HTTP bytes;
the retained-HTTP action preserves the attested bytes in its operation receipt.
Both preserve the extractor's normalized body, dates, identity metadata and
truncation limits. Transport completeness is not a model's full-original read
or a substantive completeness judgment; the existing review gates still apply.

Validation: `node scripts/validate-external-news-intake-sql.mjs` uses the existing
offline PGlite installation and actual canonical DDL / observation RPC. It never
connects to production. The new Vitest tests mock all HTTP/database activity.
