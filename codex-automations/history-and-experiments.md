# History, experiments, and imported material

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Retired implementations, task-only work, and items that must not be counted as current user-built systems.

<a id="hx01"></a>

## HX01 — Sales Nav Upload Continuation Agent

**Status:** Retired. **Purpose:** Historical scheduler that continued customer CSV uploads across tasks.

**How it works:** Task history confirms this automation was deleted at the user's request. Upload checkpoints, CSVs, receipts, and the manually invoked current skill remain. Its 117 legacy identifier matches are historical task records, not 117 different systems or proof of completed batches.

**Infrastructure:** Former Codex scheduled automation; no current saved definition.

**Evidence:** Private: Sales Nav Automation final task result; historical task metadata. Current replacement: SO12.

**Sharing:** Private source or artifacts; public description only.

<a id="hx02"></a>

## HX02 — Earlier LinkedIn schedule and provenance backfill

**Status:** Retired. **Purpose:** Earlier scheduling/connection-history mechanisms.

**How it works:** The every-other-day automation name appears in historical tasks and was superseded by the current LinkedIn coordinator. Sequence-audited provenance imports and backfill repair scripts remain as history; never infer permission from personal connection activity.

**Infrastructure:** Historical Codex task definitions and PowerShell repair/import scripts.

**Evidence:** Private: old automation identifier matches; provenance import/reconciliation scripts. Current workflows: SO07–SO08.

**Sharing:** Private source or artifacts; public description only.

<a id="hx03"></a>

## HX03 — Concurrent TAM worker pools and adaptive queues

**Status:** Retired. **Purpose:** Earlier attempts to parallelize large record-review campaigns.

**How it works:** Archived reader pools, adaptive manifests, linked-evidence shards, and continuation scripts explain the large output corpus. The current contract requires a sequential exact-record reader/independent-validator invocation with immediate publish/readback; old worker counts are not current execution guidance.

**Infrastructure:** Historical Python/JS queue builders and generated TAM outputs.

**Evidence:** Private: build_tam_16_reader_queue.py; build_tam_adaptive_work_queue.py; archived parallel output folders. Public: operations/README.md.

**Sharing:** Private source or artifacts; public description only.

<a id="hx04"></a>

## HX04 — Retired signal matching and score inflation paths

**Status:** Retired. **Purpose:** Preserve the reason older source behavior must not be restored.

**How it works:** Name-only SEC Form D and legacy name-only USAspending attachment are disabled/quarantined. The former outside-signal score delta on TAM/Old Gold is retired. New external evidence belongs in Triggered with reliable entity binding.

**Infrastructure:** Historical source paths, quarantine migrations, normalization receipts.

**Evidence:** Public: AGENTS.md historical section; config/tam-score-normalization-receipt.json; lib/triggers/quarantine.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="hx05"></a>

## HX05 — BDR lead-count and Slack coordination experiment

**Status:** Historical. **Purpose:** Historical lead-count analysis with requested internal follow-up coordination.

**How it works:** Task evidence records a scheduled-message experiment and a later cancellation request that could not be verified through the available tools. It is not a current recurring automation, and its historical outcome should not be described as a clean fully closed workflow. No messages were sent or changed during this inventory.

**Infrastructure:** Historical Slack/CRM task workflow; no matching current automation definition.

**Evidence:** Private: Count leads by BDR task final result; individual recipients and message content withheld.

**Sharing:** Private source or artifacts; public description only.

<a id="hx06"></a>

## HX06 — Imported Sales Command Center fork

**Status:** Imported. **Purpose:** Reference material audited for useful workflow patterns.

**How it works:** The folder includes a colleague's cockpit, orchestrator, outreach/qualification utilities, templates, and web app. It retains colleague-specific paths and operating assumptions. Do not attribute the whole imported system to Arman or treat it as an active personal deployment. The distinct personal adaptation is SK01–SK04.

**Infrastructure:** Imported Git repository, scripts/config/data/docs and web source.

**Evidence:** Private folder/source audit; README; helper files retaining original operator paths; Audit fork for workflows task. Not counted as a user-created current system.

**Sharing:** Private source or artifacts; public description only.

<a id="hx07"></a>

## HX07 — Expenses and compensation-request assistance

**Status:** Task evidence only. **Purpose:** Account for administrative tasks without inventing a finished automation.

**How it works:** Expense filing and a compensation-plan request appear in task history. The sampled expense turn was interrupted and did not establish successful completion. No reusable expense-submission service was identified; the separate built compensation dashboard is PT01.

**Infrastructure:** Historical task records and private administrative documents.

**Evidence:** File expenses and Submit compensation plan request task metadata; no current automation definition.

**Sharing:** Private source or artifacts; public description only.

<a id="hx08"></a>

## HX08 — Calendar visualization, file inspection, and workflow-video analysis

**Status:** Task evidence only. **Purpose:** Account for early utility tasks and captured workflow understanding.

**How it works:** Task records show calendar visualization, file inspection, and decoding a workflow video. These are task-level assisted work, not evidence of continuously running services. A historical gifting preflight package is a precursor to the current gifting skill.

**Infrastructure:** Conversation history and scratch work; historical preflight.py skill package.

**Evidence:** Private: early utility tasks; Documents/Codex historical tal-drop-workflow package. Current gifting workflow: SO11.

**Sharing:** Private source or artifacts; public description only.

<a id="hx09"></a>

## HX09 — Training-course assistance and setup troubleshooting

**Status:** Task evidence only. **Purpose:** Account for course preparation and environment setup work.

**How it works:** Onboarding/product training, Vercel connection help, and browser/runtime troubleshooting appear in history. Distinguish produced practice material and setup scripts from proven course completion or a deployed product. Bundled browser recovery copies are dependencies, not original systems.

**Infrastructure:** Historical tasks and troubleshooting artifacts.

**Evidence:** Private: training, Connect to Vercel, and runtime-diagnostic tasks; scratch browser-recovery files.

**Sharing:** Private source or artifacts; public description only.

<a id="hx10"></a>

## HX10 — Bundled plugins, runtimes, and duplicated source checkouts

**Status:** Imported. **Purpose:** Make the boundaries of authorship and counting explicit.

**How it works:** Installed vendor skills, downloaded libraries, runtimes, original browser assets, repeated Stanley clones, exports, and rendered copies support the work but are not additional user-built automations. Reconcile app code to the canonical GitHub main source rather than publishing an older folder wholesale.

**Infrastructure:** Codex/vendor installations, dependency folders, archived checkouts and output copies.

**Evidence:** Private inventory skip log and source-folder inventory. Public: docs/SOURCE_RECONCILIATION.md.

**Sharing:** Private source or artifacts; public description only.
