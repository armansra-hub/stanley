# Source reconciliation — 2026-09-09

## GitHub baseline

The public repository `armansra-hub/stanley` advertised `main` at
`2e9d5bae0f8f22365559f65365eac1dd858fe666` before this update. That commit is
“Surface verified Old Gold opportunity and intro history.” Remote HEAD was
read directly from GitHub; this was not inferred from a cached local branch.

## Local copies compared

| Workspace copy | Finding and disposition |
|---|---|
| `stanley-remediation-20260810` | All 425 tracked baseline files matched GitHub main; used as the source for an isolated handoff worktree |
| `inc5000-deploy` | Earlier main commit; only Dashboard differed from the current tracked application |
| `stanley-public-growth` | Older branch plus local TAL importer edits; preserved locally, not overlaid on main |
| `stanley-deploy-repo` | Older main checkout plus local TAL importer edits/tests; preserved locally |
| `stanley-source/stanley-main` | Unversioned historical source and private operational contracts; 146 current tracked files absent and 66 differed; not a replacement for main |
| Workspace policies/helpers | Current local workflow logic absent from the hosted repository; documented and selected for source snapshots |

Comparison normalized CRLF/LF so newline changes were not mistaken for feature
changes. Git history, tracked-file comparisons, local diffs, and critical
membership/scoring paths were inspected. Older copies contain historical local
variants, including name/domain fallback TAL assignment and superseded scoring,
coordination, and deployment paths. They were not merged wholesale. The source
copies and uncommitted edits were preserved in place.

This is a reconciliation of the known Stanley workspace copies, not an assertion
that every historical script or external workstation has been audited.

## This update

- Replaces the outdated README with the current hosted/local system boundary.
- Adds architecture, scoring, source-validation, scheduler, storage, and setup documentation.
- Corrects daily-versus-hourly scheduling, score separation, review/dismissal resurfacing, model-default, migration, and operator-role descriptions.
- Marks historical agent checkpoints as historical rather than current workload.
- Adds 15 selected local workflow source/test/schema files with a source hash manifest.
- Expands blank environment examples and excludes operational state and evidence from Git/deployment paths.
- Adds source line-ending rules so fresh Windows checkouts pass the existing SQL and script tests.
- Corrects a middleware comment to name the actual dedicated agent credentials.

The application behavior from the baseline commit is preserved. No database
migration, membership change, grade publication, outreach, or workflow activation
was performed by this handoff update.

## Validation

- Existing Vitest suite: **454 passed, 1 skipped, 0 failed** (71 test files).
- TypeScript: `tsc --noEmit` passed.
- Production-source guard: passed its local-mode check; local mode does not attest production.
- Existing local render-guard regressions: **8 passed**.
- All 15 reference source hashes matched; all 10 Python sources parsed.
- Relative handoff links resolved. The source pattern scan found no credentials in newly added files; seven existing test-fixture matches were excluded from credential findings.

The first Windows test attempt exposed CRLF-sensitive SQL assertions and Node
script loading. LF-normalized checkout plus `.gitattributes` resolved those
failures without weakening tests or changing domain rules.

Tests used the existing installed dependency tree. This audit is not a fresh
dependency-install or live database integration certification. Build/deployment
verification, if performed, is reported separately from these local checks.

## Private state and known limits

Public source does not include customer/contact lists, mailbox records, private
suppression entries, lead PDFs, production environment files, browser sessions,
live automation definitions, or operational ledgers. The selected helper
snapshots retain implementation constants and expected private paths; they are
reference code, not an independently configured runnable sales environment.

The MMTT policy's conflicting scheduling instructions are described in
[the workflow guide](../operations/README.md). The handoff does not silently
change a business rule or enable the prohibited Send Later path.

Current TAM membership/grades, outstanding work, calendar sync jobs, configured
models, enabled local automations, and deployed Vercel provenance must be read
from their authorized live systems. Repository documents and dated receipts do
not stand in for that evidence.
