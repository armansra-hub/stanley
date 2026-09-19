# Local TAM evidence navigation

`tools/tam_evidence_index.py` is an independent standard-library helper. It reads
only explicit local inputs and writes only a new, explicitly named output. It
does not import or invoke the canonical runner, search folders, read config or
credentials, claim a record, grade, validate, publish, or call a model/API.

The canonical caller must supply one exact NetSuite Internal ID and the expected
SHA-256 of the exact input bytes. A plain-text input's identity is caller-supplied;
the helper does not establish that the text belongs to that company. Artifact
inputs additionally bind their own exact ID. Keep these private outputs outside
Git, application logs, Vercel and public evidence storage.

```powershell
python tools/tam_evidence_index.py index --id 123 --input C:/private/123.txt --source-sha256 <verified-sha256> --output C:/private/123.index.json
```

No automatic overwrite occurs. The cache key includes exact ID, source hash,
format, deterministic model identity, index/rules version, date-order choice and
optional `--context-sha256`. The canonical bridge binds its context hash to the
exact evidence identity, including rubric and assessment context, plus the bridge,
index rules and Jev question versions. Changed source bytes invalidate reuse.
The deterministic index contains no model response; completed Jev annotations
have a separate exact-input and model/question-bound cache.

Every supplied character remains in lossless line spans. Offsets are zero-based
Unicode codepoints and UTF-8 bytes, with exclusive ends, within the identified
document. Lines and explicitly supplied PDF pages are one-based. BOMs, CRLF,
form feeds, Unicode and final-newline state are preserved. A plain text file has
no asserted PDF-page mapping. No PDF extraction or corpus completeness is implied.

For page pointers, the canonical caller serializes its **already verified** full
record and `pdf_page_texts` cache into this one-record envelope. `--format artifact`
requires unique, ordered PDF pages 1 through `expected_pdf_pages`; strings are
preserved exactly after JSON decoding. Supplemental evidence remains separate.

```json
{
  "schema": "tam-evidence-input", "version": 1, "internal_id": "123",
  "expected_pdf_pages": 1,
  "documents": [
    {"id": "record_text", "kind": "record_text", "text": "Complete raw text\r\n"},
    {"id": "pdf_1", "kind": "pdf_page", "page": 1, "text": "Complete verified page text"}
  ]
}
```

Date mentions and candidate interaction, speaker-label, system, budget and timing
references are navigation aids. A same-line date is **not** asserted to be the
interaction date. Invalid dates remain unresolved. Numeric dates remain unresolved
unless the caller explicitly selects `--date-order mdy` or `dmy`; there is no
inferred year or date propagation. Keywords preserve their full original line,
including negation and counterparty context. They do not establish current
software, budget viability, a human interaction, opportunity status or a grade.
Both complete reader and independent complete validator remain mandatory.

The v2 index also preserves original amount spans and uses decimal arithmetic for
explicit monthly/annual amounts, including written thousand/million multipliers.
An annual amount is divided by twelve; an unperiodized amount has no monthly
equivalent. Bare `$` remains an unspecified dollar currency. Comparisons retain
both source locations and compare only matching currency labels; they do not
identify either amount as the buyer's budget or assign affordability. Explicit
source dates are sorted and compared with the canonical assessment date in code.

The deterministic helper's `evaluate_private_candidates` hook remains disabled;
the optional client is a separate `tools/tam_jev_annotations.py` command. It binds
the index SHA-256 and exact Internal ID, accepts explicit `document_id:line`
references (including the surrounding context the caller selects), and prepares
locally by default. Its `--evaluate` option transmits those bounded excerpts through
Stanley's authenticated, budgeted private endpoint. It uses a dedicated
`CODEX_AGENT_TOKEN` or `AGENT_TOKEN` already supplied by the caller; it does not
read credential files or send the complete index. The endpoint requires the
global intelligence flag and reviewed direct TypeSafe data-handling terms.

```powershell
python tools/tam_jev_annotations.py --index C:/private/123.index.json --index-sha256 <verified-index-sha256> --id 123 --line record_text:14 --line record_text:15 --output C:/private/123.annotation-request.json
```

Add `--evaluate` and use a new output path for an explicitly selected live
annotation. Output and cache identity bind evidence, exact ID, selected lines,
model version and questions. The helper currently pins `jev-1.13.0` and
`stanley-evidence-v2`, matching the TypeScript endpoint adapter; older question
versions have different cache identities and cannot be accepted as v2 results.
Before transmitting, the client records a local
pending request receipt. An uncertain result cannot be blindly retried at the
same path. The annotations identify navigation priorities, never dates, amounts,
grades or validation results. Both complete reads remain required. No private
record has been transmitted in development tests.

## Explicit stage measurements

`timings` accepts only named compact timing files, with no automatic discovery.
Each stage receipt identifies an exact record, attempt and unique receipt, its
stage, outcome and reuse status. Supply either an explicit elapsed duration or
both timezone-aware stage-start and stage-end timestamps. A completion timestamp
alone cannot establish duration. The example below is synthetic, not a measured
production result.

```json
{
  "schema": "tam-stage-timings", "version": 1,
  "receipts": [{
    "receipt_id": "sample-reader-1", "internal_id": "123", "attempt_id": "sample-attempt-1",
    "stage": "reader", "outcome": "completed", "reused": false, "duration_ms": 1200
  }]
}
```

```powershell
python tools/tam_evidence_index.py timings --receipt C:/private/explicit-timings.json --output C:/private/stage-report.json
python -m unittest discover -s tools/tests -p test_tam_evidence_index.py
```

Reports cover preparation, reader, validator, staging and publication. They retain
sample counts, outcomes, sums, medians, nearest-rank p90, fresh/reused effort,
distinct records and distinct attempts. Identical repeated receipts are deduplicated;
conflicting duplicates fail. Raw source receipts are bound by SHA-256. Missing
stages are unmeasured. Parallel-stage sums are effort, not end-to-end elapsed time
or grades per hour. The runner now writes these stage receipts directly from its
monotonic clock. Live grading is paused, so reader/validator throughput remains
unmeasured with this integration.

## Canonical integration installed; grading remains paused

The private `C:/Users/Arman Sra/Documents/Stanley/tools/run_tam_single_record.py`
now calls `prepare_evidence_navigation` after its existing claimed-record
`local_preflight`, saved-search supplement and identity-context attachment.
`tools/tam_navigation_bridge.py` consumes that complete in-memory package. It
reuses the existing PDF page-text cache and performs no PDF extraction, corpus
scan or claim. Its private files live under the existing round's
`grading/navigation/<exact-id>/<hash>/`; there is no second grading queue.

The compact navigation block supplies original line/character/page pointers and
source-date mentions equally to both complete evidence prompts. Numeric dates
remain unresolved unless an explicit date order was supplied. Category matches
are not facts or grades. The full raw record, every numbered page, supplements,
rubric and independent validator are preserved. Navigation failure falls back to
the existing complete evidence instead of becoming another grading gate.

New model evidence identities include the navigation hash. Eligible completed
pre-integration reader artifacts retain their existing identity and reuse path,
avoiding another model pass solely to add navigation. Accepted-publication
recovery remains on the existing readback-only path and never invokes navigation
preparation or a model. The coordinator, claim fences and publisher are unchanged.

Preparation creates bounded `jev-request-NNNN.json` files with selected source
lines and adjacent context. The canonical runner supplies its already-loaded
dedicated agent token and may automatically dispatch at most **two packets** at
this claimed-record boundary. First it makes an authenticated, content-free
`POST {}` readiness probe: the existing route returns `invalid_excerpt` only
after both the intelligence and private-excerpt enablement gates have passed.
An unavailable/disabled route receives no CRM content and preparation continues.
There is no new credential flow. `TAM_JEV_ANNOTATIONS_ENABLED=false` in the local
runner environment disables dispatch; standalone helper/benchmark calls have no
token and remain offline. Each request is at most 12,000 UTF-8 bytes/40 original
source lines; surrounding lines are included within those bounds.

The result is saved as `jev-result-NNNN.json`. Only a completed output with a matching
request/index/exact-ID/model/question binding and completed output-hash receipt is
reused. Raw provider output remains in `provider_result`; no second model checks it.
Native `metadata.rawAnswers` is copied unchanged to the navigation block. Pending
or uncertain paid attempts are never automatically replayed. The first automatic
preparation freezes its navigation snapshot, so later source readiness/annotation
availability cannot invalidate an already completed reader for the same evidence.
Changed source/rubric/question versions create a new cache identity.

**Activation dependency:** production `TYPESAFE_PRIVATE_EXCERPTS_ENABLED=true`
requires the existing direct TypeSafe data-handling attestation described in
`lib/intelligence/jev.ts`, alongside global intelligence enablement and the
existing agent token. Until that server flag is enabled, the installed canonical
dispatch path is operationally unavailable and only deterministic navigation is
used. Development made no live private request. The release owner has since
reviewed the direct-account terms and saved the production flag; it takes effect
on the next Git deployment. A content-free readiness probe can confirm that
deployment without transmitting CRM evidence.

On the next separately authorized grading resume, the ordinary canonical path
uses the installed helper automatically for fresh records. The latest reviewed
handoff's pause and unresolved network-timeout claims remain intact. Installation
occurred after an authoritative OS check found zero grading processes. No control,
checkpoint, membership, claim, grade or scheduler state changed for this build.

## Local public-evidence versus CRM comparison

After canonical publication and its record/event readback have completed, the
runner makes one optional read through
`GET /api/agent/intelligence/context?internalId=<exact-id>`. The route uses the
existing agent authentication, requires one unambiguous current-TAM match and
returns at most the latest 100 current public observations, with partial coverage
explicit. It does not refresh sources, call a model, accept CRM text or write data.

`tools/tam_public_context.py` compares source-reported event dates against the
already-completed validator's last substantive human-interaction date. It retains
the canonical interaction summary locally, labels public developments before/on/
after that date, retains related/unknown account relationships and keeps missing
event or CRM dates unknown. Collection dates never substitute for event dates.
The report preserves excerpts/URLs and lives under the same canonical round's
`grading/public_context/<exact-id>/`; `latest.json` points to its hash-bound report.
No CRM content leaves the computer through this public read. Neither the report
nor its output enters the grader, changes the grade, delays publication, or
claims an old objection has been reversed. Public endpoint failure is recorded
as unavailable without blocking grading. Accepted-publication recovery is unchanged.

## Measured offline preparation and recovery benefit

A v1 offline preparation benchmark used one already captured, previously completed exact record without
a model call, claim, publication or private transmission: 85,595 record characters
and 18 cached PDF pages containing 84,979 characters. Fresh navigation preparation
took **418.8 ms**; three cached runs took **13.28, 13.26 and 13.78 ms**, a **31.5×**
reduction in this preparation stage. This saves about 0.41 seconds on reuse for
that record; it is not a claim that grades finish 31.5× faster. The subsequent v2
amount arithmetic and optional dispatch path are covered by synthetic tests;
that original benchmark does not measure live annotation or grading latency.

The private receipt is
`research/jev-ai/tam-navigation-benchmark-20260919/benchmark.json` in the canonical
workspace. `tools/benchmark_tam_navigation.py` reproduces the measurement with
explicit capture, capture hash, PDF text cache, context hash and a new output
directory. It verifies the existing source hashes without printing CRM content.

Targeted offline tests cover lossless character/page pointers, cache reuse and
source/context invalidation, corrupted-cache recovery, raw Jev result reuse,
identical complete-evidence prompt coverage, retained existing model-artifact
reuse, accepted-publication recovery isolation and the canonical rubric/claim
contracts. A stale lease test fixture was updated to include the already-required
0058 claim fields; no claim validation was weakened.
