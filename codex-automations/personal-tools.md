# Dashboards, documents, and research tools

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Standalone tools and repeatable artifact pipelines.

<a id="pt01"></a>

## PT01 — Offline compensation dashboard

**Status:** Artifact present. **Purpose:** Model monthly performance, forecast, and fiscal-year compensation.

**How it works:** A self-contained HTML dashboard calculates monthly/YTD targets, gaps, attainment, base commission, cumulative tiers, marginal annual bands, and special/referral components. Scoped localStorage preserves inputs. Completed-month locks protect edits; charts, scenario controls, reset, and print views support planning. Private plan rates and personal results are withheld.

**Infrastructure:** Standalone responsive HTML/CSS/JavaScript; browser localStorage; no external server, APIs, fonts, or dependencies.

**Evidence:** Private: compensation dashboard HTML and compensation-dashboard-handoff.md; completed build task recorded date/tier/lock/persistence checks.

**Sharing:** Private source or artifacts; public description only.

<a id="pt02"></a>

## PT02 — Resume baseline and evidence-backed work library

**Status:** Artifact present. **Purpose:** Maintain a reusable, truthful professional evidence base.

**How it works:** Separate supported achievements and work examples from target-specific positioning. Reuse candidate baseline and cross-project work-library memory; anonymize private customer and employer information. Source memory is not independently verified performance measurement.

**Infrastructure:** Applications project Markdown baseline, work-library and target memories.

**Evidence:** Private: Applications/CANDIDATE_BASELINE.md; WORK_LIBRARY_MEMORY.md; task-specific target research files.

**Sharing:** Private source or artifacts; public description only.

<a id="pt03"></a>

## PT03 — Tailored resume generation and visual validation

**Status:** Source present. **Purpose:** Produce consistent application documents from approved candidate content.

**How it works:** Generate target-specific Word/PDF layouts, revise requested bullets, export/render, and validate content and visual fit. Multiple versions are iterations of one pipeline, not separate applications. Actual resumes and career plans remain private.

**Infrastructure:** Python document builders and validators; PowerShell Word export; local rendered artifacts.

**Evidence:** Private: Applications/tools/build_account_executive_resume.py; build_*_resume*.py; render_resume_word.py; export_resume_word.ps1; validate/verify scripts.

**Sharing:** Private source or artifacts; public description only.

<a id="pt04"></a>

## PT04 — GTM career-background census

**Status:** Source present. **Purpose:** Analyze a collected profile sample and make reviewable research tables.

**How it works:** Combine input batches, normalize profiles, deduplicate stable profile IDs, classify career-background categories, and export workbooks with collection date/scope. Review scripts correct classifications. A collected sample is not guaranteed to be a complete employee census.

**Infrastructure:** Node.js extraction/normalization/review scripts; artifact-tool spreadsheets; private profile data.

**Evidence:** Private: Applications/tools profile-batch extractor, normalizer, GTM census builder, and review scripts. Exact target-specific filenames remain in the private source map.

**Sharing:** Private source or artifacts; public description only.

<a id="pt05"></a>

## PT05 — Public video-channel research library

**Status:** Source present. **Purpose:** Build a scoped learning library from public publisher metadata and inspected transcripts.

**How it works:** Discover channel videos/shorts/streams, follow observed pagination, collect publisher/date/description metadata, distinguish first-party and third-party sources, and reject wrong-company matches. Mark which transcripts were actually read; metadata-only entries do not imply video review.

**Infrastructure:** Python discovery/continuation/metadata/scope-audit/notes builders; JSON caches and reports.

**Evidence:** Private: Applications/tools channel discovery, continuation, metadata collection, scope audit, and library notes builders. Exact target-specific filenames remain in the private source map.

**Sharing:** Private source or artifacts; public description only.

<a id="pt06"></a>

## PT06 — Career-company comparison research

**Status:** Task evidence only. **Purpose:** Compare prospective employers against the user's stated sales-career priorities.

**How it works:** Use role/company research and supported candidate context to produce a dated comparison. This is a research deliverable; it is not a continuously updated recommendation service or an application-submission bot.

**Infrastructure:** Applications research memory and task outputs.

**Evidence:** Private: Rank companies for sales careers and target research task records. Personal targets and evaluations withheld.

**Sharing:** Private source or artifacts; public description only.

<a id="pt07"></a>

## PT07 — Presentation, battle-card, and architecture builders

**Status:** Artifact present. **Purpose:** Turn sales context into editable and reviewable visual deliverables.

**How it works:** Create territory-planning decks, discovery summaries, reference comparisons, battle cards, and system/ERP ecosystem diagrams. Build scripts and renders support iteration and QA. Customer-specific instances are summarized without publishing their decks or deal content.

**Infrastructure:** JS presentation builders, PowerShell extraction/export, Python PDF tooling, rendered QA artifacts.

**Evidence:** Private: Documents/Codex territory-planning and reference-deck builders; deal-folder battle-card and architecture builders; output decks.

**Sharing:** Private source or artifacts; public description only.

<a id="pt08"></a>

## PT08 — Portrait, image cleanup, recolor, and resolution utilities

**Status:** Historical. **Purpose:** Prepare images for particular slides and document layouts.

**How it works:** Historical jobs replace portraits, isolate/recolor background elements, inspect pixels/crops, sharpen/upscale supplied assets, and verify the final presentation. These are one-off asset tools; no general image service was deployed.

**Infrastructure:** Private JS/Python asset scripts and presentation renders.

**Evidence:** Private: edit_slide3.mjs; upscale_photo.py; background-recolor inspection/cleanup builders and saved outputs.

**Sharing:** Private source or artifacts; public description only.
