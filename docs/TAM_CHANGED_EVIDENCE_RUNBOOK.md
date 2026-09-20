# Canonical changed CRM evidence: executable handoff

G15 uses the existing membership, coordinator, corpus, seed API and publisher. It adds full-record change receipts and targeted successor admission. It does not change the in-progress September19 seed, score from a search row, or publish a grade itself. Every changed record still receives the complete raw/PDF read and a separate independent validator through the canonical grader.

## Ownership and current activation

The existing TAM task owns its coordinator and pending-intent reconciliation. Do not install while that task has a live coordinator/slot, reading record, or unpublished final. Coordinate a **single handoff window** with that owner after its exact pending work is reconciled; its watchdog should acknowledge the handoff and avoid immediately restarting the old coordinator. Do not stop a healthy worker, clear a lease, or edit its active context. `quiesce` verifies all canonical OS locks and zero reading/final counts, then disables future dispatch. It never terminates a process.

The current Codex `finish-stanley-jev-build` heartbeat should perform the refresh and handoff below. The other TAM watchdog continues to own normal grading. Use the Codex automation service, not a new timer, background loop, or Windows scheduled task. Stay quiet when unchanged; notify only on meaningful progress, completion, repeated failure, or required user action.

Cloud prerequisites: migrations0085,0088,0093 and0094, the exact-byte document ingestion route, and the deployment containing `view=evidence_changes`/`action=evidence_change_admit`. Migration0093 selects the newest completed canonical successor for carried finals whose original publication timestamp remains unchanged. Migration0094 preserves actual source observations when a record reverts to previously seen text during grading; the post-publication detector then finds that later observation without changing older document bytes or timestamps. Runtime locator support is a separate local installation. Its candidate bundle is:

`C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_runtime_20260920_v1/bundle.json`

SHA256 `4ecbc0b398a1b7331946f8eb22ae5a2cf4d32549e61614eeb37fe13a422ecbb6`.

This bundle contains only `tam_grading_round.py` and `tam_record_core.py` candidates. It permits exact-ID `snapshots/<snapshot>/captures/<64hex>` locators and the new `fresh-full-record-changes-v1` evidence policy. Existing rules, model/validator behavior, locks, reads and publication remain unchanged. Each target is bound to its current before-hash. A hash mismatch requires regenerating and reviewing the candidate against the newly owned runtime; never bypass it. Installation preserves both before-images, checks readback and rolls back a partial replacement. No live runtime installation was performed when this runbook was prepared.

## Commands and compact state

Run from the Stanley workspace. These variables are ordinary local paths, not secrets:

```powershell
$py = 'C:/Users/Arman Sra/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$helper = 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_changed_evidence.py'
$refresh = 'C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_refresh'
$bundle = 'C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_runtime_20260920_v1'
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

The command validates exact ID/snapshot/full-text/PDF hashes and dates, parses all pages with the existing verifier and writes a **new immutable version** inside that same company's canonical corpus. Its output is also saved as `changed_evidence_registration.json`. Aggregate those exact registration objects into a JSON array (maximum200), with one current receipt per exact ID. Registrations are evidence bindings, not grading jobs. Retain source dates and source file hashes.

At the handoff window, reconcile the existing TAM task's exact pending intents first. Set `$handoff` to a new directory beneath the same September14 output root. These commands do not bypass active locks:

```powershell
& $py $helper quiesce --directory $handoff
& $py $helper install --directory $bundle
& $py $helper export-boundary --directory $handoff
& $py $helper prepare --board "$handoff/board.json" --records "$handoff/records.json" --registrations '<registration-array.json>' --release-commit '<verified-40-character-production-commit>' --directory '<new-successor-directory>'
& $py $helper apply --directory '<new-successor-directory>' --max-operations 250
```

Repeat only the bounded canonical `apply` continuation when its durable state says no uncertain action. A pending action is resolved with the existing read-only `reconcile` command; never clear it or blindly repeat a POST. This reuses the current membership/PDF/seed transport and its existing exact company grade readback. Old published finals carry forward unchanged as historical completed evidence; changed IDs become canonical pending work; previous pending IDs remain pending; existing holds retain their exact reason. Old seed/grade/history remains intact.

```powershell
& $py $helper reconcile --directory '<new-successor-directory>'
& $py $helper activate --directory '<new-successor-directory>'
```

Activation requires a complete existing seed and exact final readback. It admits the specific change receipts, binds the canonical mission/live checkpoint to the new context, validates that context with the installed core and enables the same three-slot control **last**. Local pointer failure rolls back the before-images; an uncertain admission uses `reconcile-admission` (read-only exact receipt verification) before continuing. If control was enabled but the final local receipt was lost, `reconcile-activation` proves the exact active mission/live/context/authorization/control and live seed, then writes only that missing receipt. It does not stop or reconfigure a running worker. The helper does not launch a coordinator. The existing TAM owner/watchdog resumes the normal foreground coordinator with its current reviewed launch options and the new canonical context. It then performs the ordinary full-read/independent-validation/publish/readback flow. Cloud receipts become `published` only when that exact successor, PDF and full-record hash publish.

## Honest limits and failures

Source refresh is bounded browser rotation plus visible activity prioritization, not a NetSuite webhook or a guarantee of real-time CRM changes across all7441 accounts. Three refreshes per15-minute run provide at most288/day before page/render/lease failures; attention to changed LSAD rows reduces latency for active accounts. Public monitoring has its separate faster cloud schedule. Capture/upload blockers preserve the source target; two runs with the same failure require a specific repair instead of another blind retry.

The current round may remain active while source refresh collects durable changed evidence. Successor activation requires a coordinated drain window; repeatedly postponing that window indefinitely is not completion. Expose pending-change counts and the exact outstanding canonical reconciliation step in the heartbeat's meaningful status. Browser capture, final runtime installation and first successor activation require execution by the owning task; a prepared bundle is not an activated pipeline.

Local checks: nine offline lifecycle tests cover exact successor selection/carry-forward/holds, active-read refusal, versioned-locator confinement, source-upload uncertainty/no replay, actual browser observation freshness, atomic installer before-hashes/rollback and activation receipt loss. SQL fixture checks detection, deduplication, exact admission, unchanged old grades, matching publication, edits during grading, full-record reversion and carried-final predecessor selection.
