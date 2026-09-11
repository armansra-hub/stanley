# Evidence, data preparation, and reliability

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Capture, reconciliation, export, and runtime utilities supporting the workflows.

<a id="ev01"></a>

## EV01 — Full-record NetSuite PDF and text capture

**Status:** Source present. **Purpose:** Preserve a reviewable record corpus with exact identity and full content.

**How it works:** Capture print/linked records, extract text, inventory PDFs, and record locators, SHA-256, page counts, and timestamps. Detect missing/truncated fields; supplement from the exact live record rather than infer hidden text. PDFs remain private and local.

**Infrastructure:** Python, JS browser capture, PDF parsers, local evidence manifests.

**Evidence:** Private: tam_current_pdf_capture.mjs; extract_tam_pdf_text.py; tal_truncation_inventory.py; inventory_tam_pdfs.py. Public: scripts/tam_pdf_audit.py.

**Sharing:** Private source or artifacts; public description only.

<a id="ev02"></a>

## EV02 — Single-record TAM reader and independent validator

**Status:** Source present. **Purpose:** Make every final grade traceable to complete record review.

**How it works:** Atomically claim one exact Internal ID, run a complete reader pass and independent complete validator reread, validate schema and source hashes, publish immediately, confirm exact record/event, and checkpoint before the next record. Partial reads and unverified finals fail closed.

**Infrastructure:** Python runner/core, JSON schemas, authenticated coordination service.

**Evidence:** Public: operations/reference/tools/run_tam_single_record.py; tam_record_core.py; tam_v9_reader_schema.json; tam_v9_validator_schema.json.

**Sharing:** Reviewed actual source snapshots are public under operations/reference; private evidence and coordination configuration are required.

<a id="ev03"></a>

## EV03 — TAM checkpoint, membership, and final reconciliation

**Status:** Source present. **Purpose:** Keep the current exact account set and published grades consistent across tools.

**How it works:** Compare current membership, verified evidence, staged finals, live readback, and event receipts. Resolve schema/hierarchy/current-opportunity exceptions through the canonical checkpoint; preserve hold and removed-record history. Counts alone are insufficient; exact-ID sets and digests matter.

**Infrastructure:** Python/JS audit and reconciliation scripts, seed/sync jobs, database migrations.

**Evidence:** Public: scripts/tam-checkpoint-seed.mjs; scripts/tam-coordination-sync.mjs; scripts/tam-local-evidence-sync.mjs. Private: reconcile_tam_live_finals.py and validate_tam_final_output.py.

**Sharing:** Private source or artifacts; public description only.

<a id="ev04"></a>

## EV04 — TAL and TAM review workbooks and pipeline summaries

**Status:** Artifact present. **Purpose:** Turn validated evidence into usable account review and pipeline artifacts.

**How it works:** Aggregate reviewed facts, judgments, holds, and source references into workbook datasets. Generate formatted spreadsheets and verify row coverage, output integrity, and corrections. Workbook summaries do not replace raw evidence or the canonical live set.

**Infrastructure:** Python dataset/aggregation; JS workbook builders; local spreadsheets and QA.

**Evidence:** Private: tal_workbook_dataset.py; build_tam_scoring_workbook*.mjs; make/work TAL workbook/pipeline builders and verifiers; TAL Excel task.

**Sharing:** Private source or artifacts; public description only.

<a id="ev05"></a>

## EV05 — Current-customer CSV split and verification

**Status:** Artifact present. **Purpose:** Prepare large customer exports for destination row limits.

**How it works:** Split a verified master into numbered files of at most 998 data rows, preserve header/order, and validate reconstruction, row counts, and hashes. Partial/previous-customer batches retain their own provenance. Destination upload is SO12.

**Infrastructure:** Node.js split/verify scripts, CSV manifests and private output batches.

**Evidence:** Private: work/ars-current-customers-split/split.mjs; work/ars-current-customers-verify/verify.mjs; Customers CSV task.

**Sharing:** Private source or artifacts; public description only.

<a id="ev06"></a>

## EV06 — Browser leases, workflow locks, and bounded execution

**Status:** Source present. **Purpose:** Prevent overlapping external actions and resource-heavy idle runs.

**How it works:** Acquire and heartbeat the browser lease and workflow lock; load exact bounded state, act on one item, verify, checkpoint, and release. Preserve ungrouped Chrome tabs and required playback focus handoff. Repeated failures become blockers, not uncontrolled UI loops.

**Infrastructure:** PowerShell locks, Python state snapshots, operating standard and receipts.

**Evidence:** Public: operations/reference/browser-automation-lock.ps1; linkedin-cadence-lock.ps1; operations/README.md. Private: AUTOMATION_OPERATING_STANDARD.md.

**Sharing:** Private source or artifacts; public description only.

<a id="ev07"></a>

## EV07 — State migration, provenance repair, and runtime diagnostics

**Status:** Historical. **Purpose:** Repair specific ledger issues and diagnose token/RAM waste.

**How it works:** Historical scripts migrate exact-contact pauses, reconcile sent evidence and imported LinkedIn provenance, repair bloated state, inspect TAM sessions, and benchmark routes. They operate on dated schemas and cases; their presence is not a current instruction to run them.

**Infrastructure:** Python/PowerShell/JS, backups, repair receipts and runtime diagnostics.

**Evidence:** Private: repair_linkedin_state_bloat.py; diagnose_tam_regrade.py; benchmark_tam_route.py; prune_closed_tam_sessions.py; dated outlook/LinkedIn reconciliation scripts.

**Sharing:** Private source or artifacts; public description only.

<a id="ev08"></a>

## EV08 — Early NetSuite export, package validation, and transfer utilities

**Status:** Historical. **Purpose:** Capture large lead packages and prepare them for controlled file transfer.

**How it works:** Full/incremental print capture and PDF rendering feed manifests; validation checks expected files, pages, and errors. Size-limited transfer packaging and copy verification helpers exist. USB formatting helpers are historical, destructive utilities requiring fresh explicit scope before any use.

**Infrastructure:** Documents/Codex scratch tools; Node.js capture/copy scripts, Python PDF checks, PowerShell transfer helpers.

**Evidence:** Private: netsuite_full_print_capture.mjs; netsuite_incremental_print_capture.mjs; verify_netsuite_pdf_package.py; make_masv_under_15gb_output.mjs; USB helper sources.

**Sharing:** Private source or artifacts; public description only.
