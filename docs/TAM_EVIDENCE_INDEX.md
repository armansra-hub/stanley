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
optional `--context-sha256`. The context hash should bind the canonical rubric,
instructions and relevant assessment context when integration is introduced.
Changed source bytes invalidate reuse. No model response is cached or reused.

Every supplied character remains in lossless line spans. Offsets are zero-based
Unicode codepoints and UTF-8 bytes, with exclusive ends, within the identified
document. Lines and explicitly supplied PDF pages are one-based. BOMs, CRLF,
form feeds, Unicode and final-newline state are preserved. A plain text file has
no asserted PDF-page mapping. No PDF extraction or corpus completeness is implied.

For page pointers, the future caller can serialize its **already verified** full
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

The deterministic helper's `evaluate_private_candidates` hook remains disabled;
the optional client is a separate `tools/tam_jev_annotations.py` command. It binds
the index SHA-256 and exact Internal ID, accepts explicit `document_id:line`
references (including the surrounding context the caller selects), and prepares
locally by default. Only `--evaluate` transmits those bounded excerpts through
Stanley's authenticated, budgeted private endpoint. It uses a dedicated
`CODEX_AGENT_TOKEN` or `AGENT_TOKEN` already supplied by the caller; it does not
read credential files or send the complete index. The endpoint requires the
global intelligence flag and reviewed direct TypeSafe data-handling terms.

```powershell
python tools/tam_jev_annotations.py --index C:/private/123.index.json --index-sha256 <verified-index-sha256> --id 123 --line record_text:14 --line record_text:15 --output C:/private/123.annotation-request.json
```

Add `--evaluate` and use a new output path for an explicitly selected live
annotation. Output and cache identity bind evidence, exact ID, selected lines,
model version and questions. Before transmitting, the client records a local
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
or grades per hour. No production timing inputs were inspected for this change;
there is no claimed grader throughput improvement yet.

## Future canonical integration boundary — not enabled

Read-only source inspection found the narrow insertion point in the current
private `C:/Users/Arman Sra/Documents/Stanley/tools/run_tam_single_record.py`:
the normal claimed-record path calls `local_preflight(internal_id)` around line
2224, attaches current context and identity-review evidence, then computes
`evidence_identity` and checkpoints `local_evidence_verified`. After those existing
checks, the same caller could explicitly pass the already loaded full text/pages
to this helper before `get_or_run_reader` around line 2244. Do not integrate in
the accepted-publication recovery path, which should preserve validated reuse.

The full input source comes from `tam_record_core.trusted_package`, including its
existing verified PDF text cache; do not extract another PDF package. The reader
and validator prompt builders are in `tam_record_core.py` around lines 572 and 589.
Future optional navigation metadata must be added equally alongside unchanged
complete evidence and must not become a filter, synopsis or validator substitute.
Model/instruction reuse bindings must change deliberately if their prompts change.

Integrate only at an approved, drained canonical boundary. The latest reviewed
handoff dated 2026-09-18 22:46 UTC records the user's pause and unresolved original
claims; this helper neither resumes that work nor resolves those claims. No
canonical source, control, checkpoint, queue or handoff was changed.
