# Stanley

Stanley is a single-user prospecting and workflow assistant for a NetSuite account executive. It combines a hosted application with local, supervised sales workflows. The package name remains `jarvis`; the product is Stanley.

**Sharing this with a colleague?** Start with the [architecture and logic guide](docs/ARCHITECTURE.md), then [setup and infrastructure](docs/SETUP.md) and the [local workflow guide](operations/README.md).

This documentation was reconciled with GitHub `main` and the local Stanley workspace on **2026-09-09**. See the [reconciliation report](docs/SOURCE_RECONCILIATION.md) for scope and provenance. Repository configuration describes intended behavior; live database counts, configured models, scheduler status, and deployment state require authenticated readback.

## What Stanley does

| Surface | Purpose | Main implementation |
|---|---|---|
| Headhunter (`/headhunter`) | Import and monitor the TAM, manage the claimed TAL, review public signals, and prioritize TAM / Old Gold worklists | `components/Dashboard.tsx`, `lib/db/companies.ts`, `app/api/headhunter/` |
| Missions (`/missions`) | Tasks, reminders, recurring work, time placement around Outlook busy blocks, and conversational actions | `lib/missions/`, `lib/db/missions.ts` |
| Kill List (`/kill-list`) | Manually maintained pipeline, activity history, and dated tasks linked to Missions | `lib/killlist/`, `lib/db/killlist.ts` |
| Ask Stanley | Chat and voice-assisted access to application tools | `lib/chat/`, `app/api/chat/` |
| Local workflows | NetSuite evidence review, Outlook cadence, LinkedIn outreach, event invitations, and verified CRM touch logging | [operations/](operations/README.md) |

The hosted app does not replace the operator's authenticated Chrome session. Outbound prospecting runs locally under workflow rules, exact identity checks, durable state, and external verification.

## Three different kinds of prioritization

- **TAM:** `codex_score` is the raw 0–100 close-probability judgment from the NetSuite record. `tam_score` preserves it except for record-dead and confirmed NetSuite-incumbent hard zeros. Low scores are valid; do not curve them.
- **Old Gold:** historical revival potential with its own evidence-based score. Membership requires qualifying note/prior-SQL evidence or an audited dated opportunity. A non-member has `oldgold_score = null` in live storage; a full assessment can still explicitly record `old_gold_score: 0`.
- **Triggered:** public evidence of growth and operational change, ranked with signal strength, decay, and fit. Public signals never alter TAM or Old Gold grades.

TAL replacement uses exact NetSuite Internal IDs, rejects unresolved or ambiguous membership before writing, commits atomically, and verifies the result. Names and domains are context, not TAL identity keys.

## Runtime and infrastructure

Next.js 15 App Router, React 19, TypeScript, and Tailwind run on Vercel. Supabase Postgres stores business state, trigger evidence, tasks, and audit records; database service credentials remain server-only. Anthropic powers classification and conversational tools. Models are configurable; different components have different code defaults.

`vercel.json` invokes `/api/cron/daily` **hourly**, despite its historical name. Each invocation runs one five-request stage from an 80-request manifest, giving a 16-stage rotation. Prime-award checks and candidate review appear in every stage. Data foundation imports are separate jobs. Coverage targets are plans, not guarantees that a provider succeeded.

Production source is **GitHub `armansra-hub/stanley`, branch `main`**, through the existing Vercel Git integration. The source guard, platform permissions, and exact post-deploy source readback are the release controls. Do not deploy a local directory or prebuilt upload to production.

## Local development

Use Node.js 20 or later and npm. The committed `package-lock.json` is the dependency lockfile.

```bash
npm ci
cp .env.example .env.local
# Configure your own development Supabase project and credentials.
# Apply the reviewed migration set described in docs/SETUP.md.
npm run dev
```

PowerShell users can use `Copy-Item .env.example .env.local` instead of `cp`.

```bash
npm test
npx tsc --noEmit
npm run check:production-source
```

`npm run build` generates art and builds the application. A complete production release also requires migration and deployed-source verification.

## Repository map

| Directory | Contents |
|---|---|
| `app/`, `components/` | Pages, UI, and server route handlers |
| `lib/` | Domain logic, database access, ingestion, agent tools, and tests |
| `config/` | Territory, sources, signals, and dated baseline receipts |
| `supabase/migrations/` | Ordered SQL schema and transactional guards |
| `scripts/`, `tools/` | Application foundation, evidence registration, and verification utilities |
| `operations/` | Local workflow specification and reviewed source snapshots; not hosted automation |
| `docs/` | Architecture, setup, reconciliation, and signal quarantine runbook |
| `public/art/` | Versioned assets shipped with Git-sourced builds |

This repository is public. Credentials, CRM exports, contact lists, mailbox threads, browser sessions, PDF evidence, live ledgers, and access grants remain outside it. Cloning the code does not grant access to the existing app, database, accounts, or customer records.
