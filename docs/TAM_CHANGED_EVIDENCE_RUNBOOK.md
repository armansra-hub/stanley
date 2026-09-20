# Canonical changed CRM evidence: executable handoff

G15 uses the existing membership, coordinator, corpus, seed API and publisher. It adds full-record change receipts and targeted successor admission while preserving predecessor evidence, seeds and grade history. It does not score from a search row or publish a grade itself. Full native Jev answers remain available without an added semantic reviewer. Every changed record still receives the complete raw/PDF read and separate independent validation required by the canonical grader.

## Ownership and current activation

The existing TAM task owns its coordinator and pending-intent reconciliation. Do not install while that task has a live coordinator/slot, reading record, or unpublished final. Coordinate a **single handoff window** with that owner after its exact pending work is reconciled; its watchdog should acknowledge the handoff and avoid immediately restarting the old coordinator. Do not stop a healthy worker, clear a lease, or edit its active context. `quiesce` verifies all canonical OS locks and zero reading/final counts, then disables future dispatch. It never terminates a process.

The existing fifteen-minute changed-evidence heartbeat remains active for the refresh and handoff below. The canonical TAM owner/watchdog remains the sole owner of bulk grading and is running after the 10:46 UTC resumption. Use the Codex automation service, not a new timer, background loop, or Windows scheduled task. Stay quiet when unchanged; notify only on meaningful progress, completion, repeated failure, or required user action.

### Optional dispatch pause after owner review

Migration 0098 adds an optional, exact-run/seed admission gate. It defaults to `paused:false`, revision 0; deployment does not pause work. The canonical owner reviewed it without a blocking finding. The first handoff used a natural drain without a gate pause. After the successor's later capacity failure, the owner drained again and left local dispatch disabled; that control state is distinct from the optional server selector gate.

If the owner chooses to use it, `tools/tam_dispatch_gate.py` reads the active canonical run/seed, saves an operation intent, and changes only the broad pending-record selector. It does not revoke a claim, stop an admitted record, change a grade, edit runtime files or replace `quiesce`. **A selector can already be in flight when the pause takes effect.** Wait for the owner's actual terminal to become idle and verify zero reading/final records and all canonical locks before export or successor admission.

Use the app helper only after the matching API deployment and owner agreement. Each change uses a new receipt directory:

```powershell
$py = 'C:/Users/Arman Sra/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$gate = 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_dispatch_gate.py'
& $py $gate snapshot
& $py $gate pause --directory '<new-pause-receipt-directory>'
```

Confirm its exact run, seed, operation ID, next revision and `paused:true` readback. If the write is uncertain, run `reconcile --directory '<same-pause-receipt-directory>'`; this performs GET-only recovery and never repeats the POST. A missing or superseded operation stays unresolved until the owner reconciles it. If the handoff is abandoned while that same canonical round remains active, use `resume --directory '<new-resume-receipt-directory>'` and verify `paused:false`. After successful successor activation, the new run starts with its own default unpaused gate; do not resume the retired predecessor merely to remove its pause. This protocol supplements the existing idle-boundary and activation steps below.

Cloud prerequisites: migrations 0085, 0088, 0093, 0094 and 0097, the exact-byte document ingestion route, and the deployment containing `view=evidence_changes`, `action=evidence_change_admit` and `action=evidence_successor_initialize`. Migration 0093 selects the newest completed canonical successor for carried finals whose original publication timestamp remains unchanged. Migration 0094 preserves actual source observations when a record reverts to previously seen text during grading; the post-publication detector then finds that later observation without changing older document bytes or timestamps. Migration 0097 copies exact unchanged membership/PDF registrations within the existing checkpoint lifecycle. Confirm its migration and application deployment receipts before using a newly prepared fast-path plan.

For a predecessor with historical claim metadata retained on completed publications, also require the **0099 compatibility correction** before retrying initialization. The canonical publisher retains that metadata, including a possible claim token, for idempotent publication receipts; it does not by itself mean a published record is still being read. The corrected guard exempts only `published` records with passed validation and a publication timestamp. It still rejects reading/final work and residual claim state on pending/hold records, and preserves the exact membership, PDF and provenance checks. Do not erase historical claim fields to pass the guard; the normal GET record export does not expose every token field.

Runtime locator and Windows long-path support were installed by the canonical owner at **2026-09-20T08:13:23Z**, according to `outputs/tam_refresh_2026-09-14/changed_evidence_runtime_long_paths_20260920/installation.json` (SHA256 `56c5d959618029ae8d216954d258cfcea6db4f2a748e62a484bd0c37d2bf41a4`). The installed bundle is:

`C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_runtime_long_paths_20260920/bundle.json`

SHA256 `bf978295abd9fa51f624dea9cd8e8de097d5aae9b2356ad73291d40a7e007876`.

This bundle contains only `tam_grading_round.py` and `tam_record_core.py`. It permits exact-ID `snapshots/<snapshot>/captures/<64hex>` locators and the `fresh-full-record-changes-v1` evidence policy. Windows extended paths are used only for file I/O; stored canonical locators remain ordinary relative paths. Existing model/validator behavior, locks, reads and publication remain unchanged. Installation retained both before-images and exact readback. Do not reinstall or alter the owner's active runtime for the server fast path.

### Recorded first-successor checkpoint

All **80 initialization operations completed**, including checkpoint finalization. `response_00079.json` in `outputs/tam_refresh_2026-09-14/changed_evidence_successor_20260920_10530959` verifies 7,441 current/PDF-verified records, 623 carried publications, 24 holds and 6,794 pending records, with zero reading/final/expired records and existing company grades preserved. The completed seed is `3380a929-afde-429f-9ffb-486c17865554`. All 623 carried finals have verified original Jev, full-reader, independent-validator and publication lineage, with zero anomalies; the accepted lineage manifest SHA256 is `28257e5aa15c8c7527b4de4140b750cf2bb3c70a97413077b71c58861f368070`.

Fresh record **10530959 was admitted**, canonical pointers were updated and staged activation validated the context with dispatch disabled. The exact `activation_receipt.json` SHA256 is `4d8f858efd33b1452d8fe83b79bba55e1245e0e51c236eb435fedc99d589d191`. The owner then repinned its adapter and launched the canonical coordinator. ID **19121622 published as event 65844 at 10:31:09 UTC**, but claims for IDs 10530959 and 19199963 received HTTP 409 responses because the server's capacity rule still depended on the predecessor run slug.

The owner's `development/claim_capacity_recovery_20260920/root_drained_ready.json` records the subsequent **10:32:57 UTC** boundary: 624 published, 24 holds, 6,793 pending, zero active records and `controlEnabled:false`. Migration **0100** applied at **10:37:52.143238 UTC**. The root release artifact `capacity-0100-readback.txt` confirms three-slot server capacity and zero active work; both rejected IDs remain pending with claim generation zero, no token and no claim/publication events. Production attests `55b7adfde6ec4b3d8bdc5f1f59efbf7008a3f71b`, with the helper's three-slot preflight. The capacity source tests and helper lifecycle suite passed 40 and 16 checks respectively.

At **10:40:42 UTC**, the owner installed the local required-Jev context compatibility correction after independent review and 49 synthetic checks; its no-apply verification made zero API requests. The two definitively rejected claims were reconciled and the canonical coordinator resumed at **10:46 UTC**. The capacity and context failures are resolved.

Changed record **10530959 completed required Jev processing, the full reader and the independent full validator**, then reached **`validator_hold` at 11:03:43 UTC**. Its canonical name is “Duplicate,” its domain is `duplicate.com`, and its record mixes Sterling Group and Capital Insurance evidence; a 2022 cleanup note says the correct account was unidentified. Preserve the hold and old grade until that identity is resolved. This is a supported evidence-ambiguity outcome, not a software failure. The root release artifact `research/jev-ai/g1-g15-release-20260920/changed-held-lifecycle-readback.json`, observed at **11:14:09 UTC**, confirms the admitted fresh PDF/exact seed, held record, preserved predecessor and previous company grade, and zero successor publication events. The owner's `independent_hold_review.json` (SHA256 `5ce1324d2e48cb66ccd52501ee655b5c270a5370472da1a8b523f1d61429759e`) binds both complete 150,487-character/105-page reads and two actual Jev results; no software gate failed.

**G15 implementation and activation are complete. No live changed-record publication is claimed.** The publication branch is covered separately by SQL tests; this first live changed-record run establishes the hold path. The healthy owner session 73698 reported 13 new publications, 637 total published and one new validation hold at this checkpoint. Bulk grading and the fifteen-minute source-refresh monitor continue through their existing sole owners.

The immutable plan still identifies release `8ee9b2b31f82ee21ba356ce0bcc3801ace2dacdd`. Compatible server corrections do not justify rewriting that plan or its manifest. Initialization, admission, staged activation and ordinary publication each retain their own receipt; one does not stand in for another.

## Commands and compact state

Run from the Stanley workspace. These variables are ordinary local paths, not secrets:

```powershell
$py = 'C:/Users/Arman Sra/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
$helper = 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_changed_evidence.py'
$refresh = 'C:/Users/Arman Sra/Documents/Stanley/outputs/tam_refresh_2026-09-14/changed_evidence_refresh'
& $py $helper refresh-snapshot --directory $refresh
```

`refresh-snapshot` uses the existing authenticated canonical API client without revealing credentials. It returns `nextStep`, exact ID, known print URL, source-record path, pending-change count and coordinator busy status. It reads one bounded 100-row page from the **current canonical board**; only published validated records qualify. A durable offset advances after exact upload readback, or past a page without eligible published records. One unfinished `refresh_target.json` is resumed rather than replaced. There is no copied membership list or grading queue.

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

New plans pause the predecessor, perform one atomic `evidence_successor_initialize` call, verify copied membership, then retain the canonical checkpoint batches, finalization and exact company-grade readback. The one copy call is limited to a 4 MB request and 200 changed records; it fingerprints the exact completed predecessor seed, current IDs, membership ordinals/hashes, PDFs, grades, provenance and holds. Unchanged PDFs are copied in the database instead of re-registered individually. For 7,441 members, the plan has 80 parent operations when predecessor pause is needed, including 75 existing 100-row seed batches. Those seed batches still use the canonical 20-row transport; this is not 80 total HTTP requests. Continue in bounded five-operation invocations.

Repeat only the canonical `apply` continuation when durable state says no uncertain action. A pending action is normally resolved with read-only `reconcile`; never manually clear it or blindly repeat a POST. Accepted fast-init recovery requires the saved response's fencing token and exact live seed/manifest. If that response was lost, retain the intent for explicit token recovery. The separate proven-rejection path below applies only when initialization definitively failed without creating a successor. Existing plans without `successorInitialize` retain their original operation indexes and transport; never convert an in-progress journal in place. Old published finals carry forward unchanged as historical completed evidence; changed IDs become canonical pending work; previous pending IDs remain pending; existing holds retain their exact reason. Old seed/grade/history remains intact.

### Recover one definitively rejected initialization

An HTTP 409 alone does not authorize another POST. The supported case is the exact atomic database rejection **`predecessor membership or idle boundary differs`** from `tam_initialize_changed_successor`, corresponding to API error `Changed successor initialization failed: predecessor membership or idle boundary differs`. A timeout, gateway 504, truncated/absent HTTP body, saved success response or existing successor/seed remains ambiguous or accepted work and cannot use this recovery. Capacity-related claim failures after successful activation are separate operations and cannot use rejected-initialization recovery.

Preserve the original pending intent and error evidence. New app-adapter failures save `apply_failure_<pending-hash>.json` with the actual HTTP attributes when available. For the earlier failure whose HTTP body was not retained, use the reviewed authoritative database log; do not invent an HTTP response. Prepare an explicit reviewed JSON receipt containing:

- `schema:"tam-successor-init-rejection-review"`, `version:1`, `reviewedBy` and timezone-qualified `reviewedAt`.
- The exact immutable `planSha256` and an exact JSON copy of the current `pendingAction` (including operation index, payload hash and original start time).
- `rejection:{kind:"database_log",source:{path,sha256},logId}` for the saved raw database log, or `kind:"http_failure"` with a source reference to the actual adapter failure receipt. Source paths are workspace-relative and source bytes are hash-bound.

The helper checks the exact ERROR/P0001 function/message and timestamp for database evidence, or the complete original 409 body/hash for HTTP evidence. Both must match the original request window and reviewed plan/intent. Confirm the corrective server migration, including 0099 when applicable, before the subsequent apply:

```powershell
& $py $helper recover-rejected-init --directory '<same-successor-directory>' --rejection '<reviewed-rejection.json>' --rejection-sha256 '<exact-64-character-review-hash>'
& $py $helper apply --directory '<same-successor-directory>' --max-operations 1
```

Recovery acquires the existing local locks, requires dispatch disabled, verifies the exact unaccepted operation and performs **GET-only** checks: the successor must be conclusively absent, and the same canonical predecessor must be paused with zero reading/final/expired-lease counts. It archives the complete original state and proof under `rejected_initialization/<pending-hash>/`, then clears only that proven-rejected pending action; the plan, payload and operation index remain unchanged. It performs no cloud write. Repeating recovery for the same cleared intent is a no-op, while a later failed attempt cannot reuse the old rejection receipt. After one corrected apply is acknowledged, continue the ordinary bounded initialization. Any new uncertainty retains a new pending intent.

Before activation, preserve the retained evidence lineage for every carried final:

```powershell
& $py 'C:/Users/Arman Sra/Documents/Stanley/stanley-jev-intelligence-20260918/tools/tam_changed_lineage.py' --records "$handoff/records.json" --plan '<new-successor-directory>/plan.json' --predecessor-root '<predecessor-artifact-root>' --output '<new-successor-directory>/inherited_final_lineage.json'
```

The local manifest binds the original publication, checkpoint, source-bound Jev preparation, reader and validator artifacts by hash. It does not read PDFs or call a model. Later successors reuse the exact predecessor manifest and plan while preserving the original evidence and parent references. Require `status:verified` and no exact-ID anomalies; retain failed manifests for diagnosis rather than overwriting them. Use the fixed filename `inherited_final_lineage.json` so future handoffs can find it.

```powershell
& $py $helper reconcile --directory '<new-successor-directory>'
& $py $helper activate --directory '<new-successor-directory>'
```

When the owner must repin its adapter manifest to the successor context before dispatch, use `activate --directory '<new-successor-directory>' --keep-dispatch-disabled`. This performs the same cloud admission, canonical pointer/context validation and parallel-authorization setup, while keeping `tamRegrade.enabled:false` throughout. The receipt reports `canonical_successor_activated_dispatch_disabled`, `dispatchEnabled:false` and `pendingOwnerEnable:true`. The owner then repins and validates its adapter before separately enabling normal dispatch. Repeating activation never enables a staged successor or repeats admission; `reconcile-activation` reports the actual disabled/enabled control state and refreshes only the receipt, including after the owner enables it. The ordinary activation command retains its existing enable-last behavior for a first activation.

Before owner enablement, verify that the **exact successor run and seed** have effective server capacity for the authorized three slots, alongside the local parallel authorization. A local three-slot setting does not establish server capacity. The applied 0100 correction and helper preflight address this mismatch; preserve their deployment/readback and implementation receipts and check each later successor's effective capacity. Preserve and reconcile each rejected or uncertain claim through its owning coordinator; never erase claim state or reinitialize an already admitted successor to repair capacity.

Activation requires a complete existing seed and exact final readback. It admits the specific change receipts, binds the canonical mission/live checkpoint to the new context and validates that context with the installed core. Ordinary activation enables the same three-slot control **last**; staged activation leaves it disabled for owner repinning and separate enablement. Local pointer failure rolls back the before-images; an uncertain admission uses `reconcile-admission` (read-only exact receipt verification) before continuing. If the local activation receipt was lost, `reconcile-activation` proves the exact mission/live/context/authorization/control and live seed, then records the actual staged or enabled state without enabling anything. It does not stop or reconfigure a running worker. The helper does not launch a coordinator. The existing TAM owner/watchdog resumes the normal foreground coordinator with its current reviewed launch options and the new canonical context. It then performs the ordinary full-read/independent-validation/publish/readback flow. Cloud receipts become `published` only when that exact successor, PDF and full-record hash publish.

## Honest limits and failures

Source refresh is bounded browser rotation plus visible activity prioritization, not a NetSuite webhook or a guarantee of real-time CRM changes across all 7,441 accounts. Three refreshes per 15-minute run provide at most 288/day before page/render/lease failures; attention to changed LSAD rows reduces latency for active accounts. Public monitoring has its separate faster cloud schedule. Capture/upload blockers preserve the source target; two runs with the same failure require a specific repair instead of another blind retry.

The current round may remain active while source refresh collects durable changed evidence. Later successor activations still require a coordinated drain window. Expose pending-change counts, record holds and any exact outstanding canonical reconciliation step in the heartbeat's meaningful status. The first successor's initialization, admission, activation and owner resumption are complete. ID 10530959 remains held for unresolved identity; do not retry it merely to obtain a publication, remove its hold, or replace its old grade without the canonical resolution and validation path. A held record does not prevent the sole owner from continuing other eligible records.

Local checks: sixteen offline lifecycle tests cover exact successor selection/carry-forward/holds, active-read refusal, real Windows paths beyond 260 characters through the canonical PDF reader, fresh metadata repair without source changes, source-upload uncertainty/no replay, browser observation freshness, installer before-hashes/rollback, staged activation/receipt recovery, fast-path fingerprint/operation compatibility, saved-response recovery and proof-bound rejection recovery. Separate SQL fixtures exercise the actual canonical checkpoint lifecycle and historical-publication compatibility. At **11:15 UTC**, `node scripts/tests/tam-changed-evidence-migration.mjs` passed **24 checks**, including a matching-hash publication consuming its change receipt, a wrong hash not consuming it, and evidence reversion during grading. The live receipts establish initialization, admission, activation, owner resumption and the first changed record's validation hold. Neither those receipts nor the tests establish a live changed-record publication, universal coverage or a measured refresh rate.
