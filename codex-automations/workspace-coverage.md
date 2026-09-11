# Inventory coverage and evidence

[Catalog home](README.md) · [Structured catalog](catalog.json)

This inventory was assembled on **2026-09-11** from the local Codex project registry, task database, saved automation definitions, filesystem metadata, selected task outcomes, and representative implementation/policy/artifact contents. The app's saved-project listing alone was incomplete, so local project/root mappings and historical task working directories were also used.

## Scope measured

| Evidence surface | Observed scope | What the review did |
|---|---:|---|
| Saved projects | 12 | Resolved project roots and supplementary folder mappings. |
| Local task metadata | 1,827 records, including 937 archived | Indexed titles/names, source/type, workspace, dates, and history locators. Included internal child/guardian records without counting them as separate builds. |
| Top-level task index | 416 records | Reviewed the task-name/workspace inventory, grouped recurring runs, and checked selected outcomes and source artifacts. Full transcripts were not all reread. |
| Distinct recorded working-directory strings | 42 | Used them to widen folder discovery; normalized Windows path prefixes. Several are subfolders or duplicates, not distinct products. |
| Primary recursive filesystem inventory | 227,670 files; 24,114 directory records | Enumerated metadata across the roots below; inspected relevant source/policy/README and output evidence. These totals include many generated records and repeated app copies. |
| Supplemental personal plugin | 10 source files | Inspected manifest and three skill packages; checked personal marketplace registration. Its staging copy was already in the primary scan. |
| Saved automation definitions | 6 | Read configuration and prompts, summarized schedules and drift; made no changes. |
| Deliberately skipped directory entries | 97 | Dependency trees, Git internals, caches, bundled system skills, runtimes, and links/junctions. |
| Access errors | 30 directories | Old generated TAM `generation` subfolders under one archived parallel continuation run denied access. Their parent campaign and source tools were identified. |

The task database is live. These are the captured snapshot counts, not a promise that later tasks or files are included. Metadata enumeration does **not** mean every PDF page, message, generated JSON record, or source line was read.

## Saved-project coverage

Customer deal projects use public aliases. The private inventory retains their exact names, task IDs, file locations, and source mapping.

| Saved project or public alias | Material identified | Catalog coverage |
|---|---|---|
| Stanley | Hosted app, source foundations, private browser workflows, ledgers, capture/review/export tools, archived runs and repeated checkouts | ST01–ST10, SG01–SG11, SO01–SO15, EV01–EV08, HX01–HX04 |
| Sales hub | Morning/recap policies and receipts, Outlook cadence/state/audits, exact-contact reconciliation | SO01–SO06, SK05–SK06 |
| Sales command center | Imported colleague fork with cockpit/orchestrator/web/scripts/templates; audit led to a separate personal plugin | HX06, SK01–SK04 |
| Intro Calls | Standing playbook, account research, current preparation artifacts | KN01–KN02, KN12–KN13 |
| Deal A: energy marketplace | Deal knowledge, one-pager, historical audit, transaction-revenue research; supplemental Desktop documents | KN03, KN05 |
| Deal B: aviation maintenance | Imported conversation/source inventory, current memory, investment/ROI recaps, architecture/slide builders; supplemental Desktop files | KN03–KN04, PT07–PT08 |
| Commissions calculator | Offline HTML dashboard, handoff documentation and private plan inputs | PT01 |
| Deal C: healthcare staffing | Deal memory, imported context, reference/partner notes and summaries; supplemental Desktop files | KN03, KN06 |
| Deal D: aircraft services | Website brief, external report, battle cards, PDF/Word/slide builders and QA | KN03, KN07, PT07 |
| Applications | Candidate/work-library memory, target research, resume builders/validators, profile census, video library tools, generated output | PT02–PT06 |
| Deal E: moving/logistics | Intro preparation, dated call/follow-up notes and durable memory | KN03, KN08 |
| NetSuite Knowledge | Initial curriculum, territory/transcript maps, lesson, progress ledger, research references | KN09–KN10 |

## Additional folders and historical work

The primary roots were the entire local **Documents** tree; custom **Codex skills**, **worktrees**, and **visualizations** trees; three linked **Desktop deal folders**; and the linked **Downloads deal workspace**. Saved project roots and all recorded working directories were used to find coverage outside Documents. The personal plugin under the user's separate **plugins** directory and its marketplace entry were checked additionally.

- **Documents/Codex dated scratch folders:** early NetSuite full/incremental PDF export and packaging, USB transfer helpers, historical gifting preflight, territory planning, internal BANT/deal decks, customer-reference comparisons, slide edits, image work, and research outputs.
- **Stanley/tools, root scripts, make, work, tmp, and outputs:** state readers, evidence capture, review/validator tools, workbooks, CSV splitting, browser locks, dated touch/send reconciliation, source release tools, resource diagnostics, and historical worker campaigns. These support the parent systems; hundreds of batch scripts and thousands of records are not counted as new products.
- **Personal custom skills:** Sales Navigator customer CSV upload and TAL gifting, including the upload-state helper. Bundled vendor skills are excluded from personal authorship.
- **Personal plugin and visualization staging:** the Arman Sales Ops plugin's manifest, three skill packages, references, and agent descriptors. Its staged copy is the same build.
- **General Documents folders, templates, Zoom material, and miscellaneous files:** inventoried as part of the broad tree; source inputs and general user files are not automatically labeled Codex creations. No independent automation was established merely because a file existed there.
- **Conversation-only utilities:** calendar visualization, file inspection, workflow-video analysis, sales-copy revisions, product/competitive research, training assistance, administrative requests, and setup troubleshooting remain explicitly represented as task evidence or historical work.

## Attribution and status decisions

Task titles are discovery hints, not completion proof. Where available, source files, generated artifacts, saved definitions, or final outcomes provide stronger evidence. The catalog uses conservative status labels and does not equate an interrupted task, draft, scheduled definition, or helper file with a functioning unattended system.

The imported Sales Command Center fork is explicitly attributed as imported. The personal plugin created after its audit is listed separately. Older Stanley clones and the previous sharing worktree are copies of the app, not independent builds; the current public code baseline is explained in [source reconciliation](../docs/SOURCE_RECONCILIATION.md).

Overlapping entries describe useful components and work products: for example, event follow-up uses the Outlook delivery engine, and several deal folders instantiate the same memory method. The catalog count measures documented entries, not independent automation count or business outcomes.

## Limits and private audit trail

This is the most complete inventory established from the **accessible local evidence reviewed here**. It cannot establish everything ever created in deleted folders, purged tasks, unlinked locations, other computers, or cloud-only conversations that are absent from the local registry. It did not inspect every installed application's data store or unrelated disk folder. Inaccessible archived outputs and intentionally skipped dependencies are disclosed above.

A private audit package under the Stanley workspace retains the filesystem metadata, access-error list, project/task crosswalk, raw saved definitions, and exact local evidence locations. Those files are deliberately outside the Git worktree and were not published. The public catalog contains descriptions and safe source references; it does not export CRM data, mailbox history, compensation details, or raw Codex conversations.

Future refreshes should re-enumerate project/task/schedule metadata, compare source and output changes, update stable catalog IDs, recheck status evidence, and review the exact Git diff before publishing. This catalog does not create a new recurring automation.
