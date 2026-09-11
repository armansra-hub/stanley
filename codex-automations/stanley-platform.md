# Stanley platform

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Hosted application modules and their shared infrastructure.

<a id="st01"></a>

## ST01 — Headhunter: territory and account workspace

**Status:** Source present. **Purpose:** Bring territory imports, claimed accounts, prioritization, evidence, and exports into one interface.

**How it works:** Imports normalize account records; the UI exposes TAM, Old Gold, and Triggered as different views. Company detail and history preserve the evidence behind a worklist. An imported account is not automatically a claimed account.

**Infrastructure:** Next.js App Router, React, TypeScript, Supabase Postgres.

**Evidence:** Public: components/Dashboard.tsx; lib/baseImport.ts; app/api/headhunter/.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st02"></a>

## ST02 — Exact-ID TAL membership synchronization

**Status:** Source present. **Purpose:** Keep the claimed Target Account List aligned with an exact source set.

**How it works:** Use NetSuite Internal IDs as identity. Reject unresolved or ambiguous rows before an atomic replacement; verify the resulting set. Preserve removed and duplicate rows as history rather than deleting leads.

**Infrastructure:** Server routes, Postgres transactions and migrations; local saved-search inputs.

**Evidence:** Public: docs/ARCHITECTURE.md, TAL membership section; lib/db/companies.ts; config/tal-membership-baseline.json.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st03"></a>

## ST03 — TAM record scoring

**Status:** Source present. **Purpose:** Estimate account readiness from its CRM record.

**How it works:** Keep the raw 0–100 judgment in codex_score. tam_score preserves it except for record-dead and confirmed NetSuite-incumbent hard zeros. Recency, specific disqualification, budget, conversation, and opportunity evidence matter; public signals never add points. Low grades remain valid.

**Infrastructure:** Authenticated agent score route, record-derived artifacts, Supabase.

**Evidence:** Public: lib/tamRegrade.ts; AGENTS.md; operations/README.md.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st04"></a>

## ST04 — Old Gold revival analysis

**Status:** Source present. **Purpose:** Identify evidence-supported opportunities to revive a past evaluation.

**How it works:** Grade revival independently. Membership needs the qualifying note/prior-SQL evidence or an audited dated opportunity. Explicit zero in a full assessment is different from null live worklist membership. Preserve intro-call and opportunity findings with their evidence.

**Infrastructure:** TAM review pipeline, score route, database membership guards.

**Evidence:** Public: AGENTS.md; docs/ARCHITECTURE.md; lib/tamRegrade.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st05"></a>

## ST05 — Triggered prioritization and review lifecycle

**Status:** Source present. **Purpose:** Rank fresh external changes separately from CRM readiness.

**How it works:** Combine signal strength, decay, and fit. A reviewed company reheats only from evidence whose event and detection are both newer than the human review boundary. Export freshness uses the configured window. Starred items and history support manual review.

**Infrastructure:** Trigger tables, freshness functions, dashboard, export routes.

**Evidence:** Public: lib/triggers/freshness.ts; lib/triggers/signalIntegrity.ts; config/signals.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st06"></a>

## ST06 — Missions tasks and reminders

**Status:** Source present. **Purpose:** Turn requests into dated tasks, reminders, and recurring work.

**How it works:** Conversational tools create and update missions. Scheduling considers duration, recurrence, and private Outlook busy blocks from ICS. Optional calendar invitations use configured mail infrastructure. App missions are distinct from Codex desktop automations.

**Infrastructure:** lib/missions, Postgres, ICS calendar input, optional Resend.

**Evidence:** Public: lib/missions/; lib/db/missions.ts; docs/ARCHITECTURE.md.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st07"></a>

## ST07 — Kill List pipeline and activity memory

**Status:** Source present. **Purpose:** Keep manually curated opportunities, notes, and next actions together.

**How it works:** Maintain pipeline fields and append-only activity notes; parse call logs and connect dated deal tasks to Missions. It is an operator-maintained pipeline, not an autonomous CRM replacement.

**Infrastructure:** Next.js Kill List UI, lib/killlist, Supabase.

**Evidence:** Public: lib/killlist/; lib/db/killlist.ts.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st08"></a>

## ST08 — Ask Stanley chat and voice

**Status:** Source present. **Purpose:** Provide a conversational interface to application functions.

**How it works:** Route conversation through configured model and tool contracts. Voice is an input surface for the same application capabilities; account access and tool permissions still bound actions. Model defaults vary by component and settings.

**Infrastructure:** Anthropic-backed chat orchestration; app chat routes and browser UI.

**Evidence:** Public: lib/chat/run.ts; lib/chat/tools.ts; app/api/chat/.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st09"></a>

## ST09 — Codex and Claude coordination bridge

**Status:** Source present. **Purpose:** Share bounded lead evidence, grades, task status, and messages across authorized agents.

**How it works:** Dedicated agent-token authentication protects specific endpoints. Read access uses table and scalar-column allowlists. Writes use specialized validation, dry-run support, exact identity, and atomic database guards. Cron secrets and query tokens do not grant bridge access.

**Infrastructure:** app/api/agent, server-only credentials, Supabase audit events.

**Evidence:** Public: AGENTS.md bridge contract; app/api/agent/.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.

<a id="st10"></a>

## ST10 — Git-sourced deployment and release verification

**Status:** Source present. **Purpose:** Make GitHub main describe the deployed Stanley application.

**How it works:** Push reviewed changes to the existing GitHub main branch; Vercel Git integration builds them. Source guards and post-deploy commit/repository/branch/source readback protect against drift. Local directory or prebuilt production uploads are outside the current release path.

**Infrastructure:** GitHub, Vercel, production-source guard, TypeScript and Vitest checks.

**Evidence:** Public: scripts/verify-production-source.mjs; docs/SOURCE_RECONCILIATION.md; docs/SETUP.md.

**Sharing:** Implementation is in this repository; operation requires separately authorized services and private state.
