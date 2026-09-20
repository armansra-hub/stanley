# Canonical changed CRM evidence: executable handoff

G15 uses the existing membership, coordinator, corpus, seed API and publisher. It adds full-record change receipts and targeted successor admission. It does not change the in-progress September19 seed, score from a search row, or publish a grade itself. Every changed record still receives the complete raw/PDF read and a separate independent validator through the canonical grader.

## Ownership and current activation

The existing TAM task owns its coordinator and pending-intent reconciliation. Do not install while that task has a live coordinator/slot, reading record, or unpublished final. Coordinate a **single handoff window** with that owner after its exact pending work is reconciled; its watchdog should acknowledge the handoff and avoid immediately restarting the old coordinator. Do not stop a healthy worker, clear a lease, or edit its active context. `quiesce` verifies all canonical OS locks and zero reading/final counts, then disables future dispatch. It never terminates a process.

The current Codex `finish-stanley-jev-build` heartbeat should perform the refresh and handoff below. The other TAM watchdog continues to own normal grading. Use the Codex automation service, not a new timer, background loop, or Windows scheduled task. Stay quiet when unchanged; notify only on meaningful progress, completion, repeated failure, or required user action.

### Optional dispatch pause after owner review

Migration 0098 adds an optional, exact-run/seed admission gate. It defaults to `paused:false`, revision0; deployment does not pause work. The canonical owner reviewed it without a blocking finding. At the recorded handoff checkpoint no gate pause had been executed, and the owner was allowing its current work to drain naturally.

If the owner chooses to use it, `tools/tam_dispatch_gate.py` reads the active canonical run/seed, saves an operation intent, and changes only the broad pending-record selector. It does not revoke a claim, stop an admitted record, change a grade, edit runtime files or replace `quiesce`. **A selector can already be in flight when the pause takes effect.** Wait for the owner's actual terminal to become idle and verify zero reading/final records and all canonical locks before export or successor admission.

Use the app helper only after the matching API deployment and owner agreement. Each change uses a new receipt directory:

```powershell
$py = 'C:/Users/Arman Sra/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$gate = 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_dispatch_gate.py'
& $py $gate snapshot
& $py $gate pause --directory '<new-pause-receipt-directory>'
```

Confirm its exact run, seed, operation ID, next revision and `paused:true` readback. If the write is uncertain, run `reconcile --directory '<same-pause-receipt-directory>'`; this performs GET-only recovery and never repeats the POST. A missing or superseded operation stays unresolved until the owner reconciles it. If the handoff is abandoned while that same canonical round remains active, use `resume --directory '<new-resume-receipt-directory>'` and verify `paused:false`. After successful successor activation, the new run starts with its own default unpaused gate; do not resume the retired predecessor merely to remove its pause. This protocol supplements the existing idle-boundary and activation steps below.

Cloud prerequisites: migrations0085,0088,0093,0094 and0097, the exact-byte document ingestion route, and the deployment containing `view=evidence_changes`, `action=evidence_change_admit` and `action=evidence_successor_initialize`. Migration0093 selects the newest completed canonical successor for carried finals whose original publication timestamp remains unchanged. Migration0094 preserves actual source observations when a record reverts to previously seen text during grading; the post-publication detector then finds that later observation without changing older document bytes or timestamps. Migration0097 copies exact unchanged membership/PDF registrations within the existing checkpoint lifecycle. Confirm its migration and application deployment receipts before using a newly prepared fast-path plan.

Runtime locator and Windows long-path support were installed by the canonical owner at **2026-09-20T08:13:23Z**, according to `outputs/tam_refresh_2026-09-14/changed_evidence_runtime_long_paths_20260920/installation.json` (SHA256 `56c5d959618029ae8d216954d258cfcea6db4f2a748e62a484bd0c37d2bf41a4`). The installed bundle is:

`C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_runtime_long_paths_20260920/bundle.json`

SHA256 `bf978295abd9fa51f624dea9cd8e8de097d5aae9b2356ad73291d40a7e007876`.

This bundle contains only `tam_grading_round.py` and `tam_record_core.py`. It permits exact-ID `snapshots/<snapshot>/captures/<64hex>` locators and the `fresh-full-record-changes-v1` evidence policy. Windows extended paths are used only for file I/O; stored canonical locators remain ordinary relative paths. Existing model/validator behavior, locks, reads and publication remain unchanged. Installation retained both before-images and exact readback. Do not reinstall or alter the owner's active runtime for the server fast path. **The first changed-evidence successor activation remains pending a coordinated idle handoff and its separate completion receipt.**

## Commands and compact state

Run from the Stanley workspace. These variables are ordinary local paths, not secrets:

```powershell
$py = 'C:/Users/Arman Sra/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$helper = 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_changed_evidence.py'
$refresh = 'C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_refresh'
& $py $helper refresh-snapshot --directory $refresh
```

`refresh-snapshot` uses the existing authenticated canonical API client without revealing credentials. It returns `nextStep`, exact ID, known print URL, source-record path, pending-change count and coordinator busy status. It reads one bounded100-row page from the **current canonical board**; only published validated records qualify. A durable offset advances after exact upload readback, or past a page without eligible published records. One unfinished `refresh_target.json` is resumed rather than replaced. There is no copied membership list or grading queue.

Perform up to **three exact refreshes per heartbeat** within its time/browser budget. At least every third turn uses ordinary rotation. To prioritize a visible changed LSAD row, save one observation with `internalId`, `sourceUrl`, `savedSearchName: "ARS - All Leads by LSAD"`, `rowText`, and `observedAt`, then add `--row-observation <absolute-json-path>`. This is a source-refresh hint only; the exact ID must already exist as a completed canonical record. A row does not admit a grade or change TAM membership.

Before browser work, read `AUTOMATION_OPERATING_STANDARD.md` and the computer-use skill, acquire `browser-automation-lock.ps1 -Mode Acquire -OwnerId stanley-tam-changed-evidence`, and defer if another owner holds it. Use the existing Chrome NetSuite tab, saved-login standing permission, no tab groups. Navigate to the exact returned print URL. The existing `tools/tam_capture_observed_print_dom.mjs` export `observeLoadedPrintDom(tab, internalId)` captures the whole loaded print DOM in one bounded transport with exact-length checks. Save its returned artifact under a new dated observation path; never synthesize record text or fetch the authenticated record through a shell. On a transient page error use one evidence-based recovery, then record the exact blocker. Release the browser lease and restore an existing YouTube playback tab as required by the standing rules.

```powershell
& $py $helper refresh-ingest --directory $refresh --dom '<absolute-observed-DOM.json>'
```

This stores a pending upload intent, sends the exact full record through the existing documents endpoint, confirms the exact hash once and reads its change receipt. If a POST times out, the next invocation reads the exact stored document and receipt; it **does not send the POST again**. The successful rotation advances even when unchanged. `refresh_result.json` identifies unchanged/changed, source DOM, document ID, and the change receipt; completed targets/results are archived before another target is selected. A changed record returns `render_fresh_preview_then_register`. A new observation of previously seen text still creates the appropriate change receipt, without rewriting the older document.

## Fresh evidence and safe successor

For each detected change belonging to the current predecessor, use the existing preview renderer, with the returned canonical `sourceRecordPath`, saved DOM and a new directory beneath `outputs/tam_refresh_2026-09-14`. Call its supported `--preview-dir` mode; do not promote over the old package. Independently inspect every numbered PDF page, saving the existing `tam-pdf-independent-visual-qa` receipt with rendererVersion5, exact PDF hash, page count, all inspected page numbers and no blocking findings. Then:

```powershell
& $py $helper register --preview '<preview-dir>/leads/<exact-ID>' --change '<saved-refresh-result.json>' --visual-qa '<exact-visual-QA.json>'
```

The command validates exact ID/snapshot/full-text/PDF hashes and dates, parses all pages with the existing verifier and writes a **new immutable version** inside that same company's canonical corpus. Its output is also saved as `changed_evidence_registration.json`. Registration metadata comes from the fresh source: actual PDF/text byte sizes, UTF16 character count, renderer version, observation/render times and page-verification date. Membership and supplemental-record provenance retain their own dates and hashes separately. Aggregate those exact registration objects into a JSON array (maximum200), with one current receipt per exact ID. Registrations are evidence bindings, not grading jobs.

If an already registered capture has inherited stale display metadata, use `rebuild-registration --registration '<existing-registration.json>' --output '<new-metadata.json>'`, then aggregate the new output object. This verifies exact immutable source and QA bindings and writes a new metadata file outside the package. It does not re-copy, re-render or overwrite source files or the original registration.

At the handoff window, reconcile the existing TAM task's exact pending intents first. Set `$handoff` to a new directory beneath the same September14 output root. These commands do not bypass active locks:

```powershell
& $py $helper quiesce --directory $handoff
& $py $helper export-boundary --directory $handoff
& $py $helper prepare --board "$handoff/board.json" --records "$handoff/records.json" --registrations '<registration-array.json>' --release-commit '<verified-40-character-production-commit>' --directory '<new-successor-directory>'
& $py $helper apply --directory '<new-successor-directory>' --max-operations 5
```

New plans pause the predecessor, perform one atomic `evidence_successor_initialize` call, verify copied membership, then retain the canonical checkpoint batches, finalization and exact company-grade readback. The one copy call is limited to a4MB request and200 changed records; it fingerprints the exact completed predecessor seed, current IDs, membership ordinals/hashes, PDFs, grades, provenance and holds. Unchanged PDFs are copied in the database instead of re-registered individually. For7441 members, the plan has80 parent operations when predecessor pause is needed, including75 existing100-row seed batches. Those seed batches still use the canonical20-row transport; this is not80 total HTTP requests. Continue in bounded five-operation invocations.

Repeat only the canonical `apply` continuation when durable state says no uncertain action. A pending action is resolved with read-only `reconcile`; never clear it or blindly repeat a POST. Fast-init recovery requires the saved response's fencing token and exact live seed/manifest. If the response was lost, retain the intent for explicit token recovery. Existing plans without `successorInitialize` retain their original operation indexes and transport; never convert an in-progress journal in place. Old published finals carry forward unchanged as historical completed evidence; changed IDs become canonical pending work; previous pending IDs remain pending; existing holds retain their exact reason. Old seed/grade/history remains intact.

```powershell
& $py $helper reconcile --directory '<new-successor-directory>'
& $py $helper activate --directory '<new-successor-directory>'
```

Activation requires a complete existing seed and exact final readback. It admits the specific change receipts, binds the canonical mission/live checkpoint to the new context, validates that context with the installed core and enables the same three-slot control **last**. Local pointer failure rolls back the before-images; an uncertain admission uses `reconcile-admission` (read-only exact receipt verification) before continuing. If control was enabled but the final local receipt was lost, `reconcile-activation` proves the exact active mission/live/context/authorization/control and live seed, then writes only that missing receipt. It does not stop or reconfigure a running worker. The helper does not launch a coordinator. The existing TAM owner/watchdog resumes the normal foreground coordinator with its current reviewed launch options and the new canonical context. It then performs the ordinary full-read/independent-validation/publish/readback flow. Cloud receipts become `published` only when that exact successor, PDF and full-record hash publish.

## Honest limits and failures

Source refresh is bounded browser rotation plus visible activity prioritization, not a NetSuite webhook or a guarantee of real-time CRM changes across all7441 accounts. Three refreshes per15-minute run provide at most288/day before page/render/lease failures; attention to changed LSAD rows reduces latency for active accounts. Public monitoring has its separate faster cloud schedule. Capture/upload blockers preserve the source target; two runs with the same failure require a specific repair instead of another blind retry.

The current round may remain active while source refresh collects durable changed evidence. Successor activation requires a coordinated drain window; repeatedly postponing that window indefinitely is not completion. Expose pending-change counts and the exact outstanding canonical reconciliation step in the heartbeat's meaningful status. Long-path runtime installation is complete; browser refresh and the first successor activation remain owned by the canonical task. The installation receipt does not establish successor activation.

Local checks: twelve offline lifecycle tests cover exact successor selection/carry-forward/holds, active-read refusal, real Windows paths beyond260 characters through the canonical PDF reader, fresh metadata repair without source changes, source-upload uncertainty/no replay, browser observation freshness, installer before-hashes/rollback, activation receipt loss, fast-path fingerprint/operation compatibility and saved-response recovery without reposting. Separate SQL fixtures exercise the actual canonical checkpoint lifecycle. These tests establish implementation behavior, not a completed production successor or a measured refresh rate.
