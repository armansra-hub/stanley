# Development and infrastructure handoff

## What a colleague receives

Source, migrations, tests, configuration templates, and workflow reference code are included. Existing databases, Vercel permissions, sessions, API keys, calendar URLs, evidence, and ledgers are not. Explore with a separate development database and synthetic data.

## Install and configure

1. Clone the repository and use Node.js 20+ and npm.
2. Run `npm ci`. Use `package-lock.json`; old local pnpm lockfiles are not the dependency authority.
3. Copy `.env.example` to `.env.local` and configure your own credentials.
4. Prepare the development schema below, then run `npm run dev`.

| Configuration | Purpose |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database URL and server-only data access |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public Supabase client configuration where used |
| `ANTHROPIC_API_KEY` | Anthropic SDK access |
| `APP_PASSWORD`, `APP_SESSION_TOKEN` | Single-user gate; blank only for controlled local development |
| `AGENT_TOKEN`, optional `CODEX_AGENT_TOKEN` | Dedicated bridge access, separate from cron auth |
| `CRON_SECRET`, optional `TAM_GROWTH_SWEEP_SECRET` | Scheduled worker auth |
| `APP_BASE_URL`, `APP_TIMEZONE` | Worker callback origin and display/scheduling timezone |
| `MODEL_CHAT`, `MODEL_BULK`, `MODEL_CLASSIFY` | Overrides for paths that read them; choose supported model IDs |
| `ICS_PUBLISH_URL` / stored calendar preferences | Private Outlook availability feed |
| `RESEND_API_KEY`, `FROM_EMAIL`, `USER_EMAIL` | Optional calendar invites; stored preferences may override addresses |
| `APIFY_TOKEN`, `SOCRATA_APP_TOKEN`, `EDGAR_USER_AGENT_EMAIL` | Optional source access/fair-access identity |
| `SAM_API_KEY` / `SAM_GOV_API_KEY` | Optional SAM API integration; public extracts are separate |

Legacy enrichment options remain in the template; setting a key does not enable discovery or paid actors by itself. Read the route and configuration. Never paste production secrets into issues, commits, output, or handoff documents.

## Database migrations

This handoff contains 57 SQL files, ending at `0055_trigger_review_boundary.sql`. Sort and track by **full basename**, not numeric prefix: `0034` and `0038` each have two migrations.

Apply the reviewed ordered set to a clean development database using authorized migration tooling. Existing production has a ledger and requires catalog/schema-cache comparison before release. The historical `system/apply_migrations.py` mentioned in older instructions is external to this repository; it is not part of this checkout.

`scripts/verify-db.mjs` checks several tables/configuration values. It is not a complete migration-ledger verifier and does not prove all coordination functions, grants, and migrations are current.

## Scheduled infrastructure

- Vercel: hourly `/api/cron/daily`, defined by `vercel.json` and `lib/cron/dailyPlan.ts`. Confirm plan support for cadence and function duration on a new instance.
- Foundations: deliberate script/POST runs for bulk data; refresh cadence must be configured separately.
- Calendar: `/api/cron/calendar-sync` exists separately. Historical notes describe an external/pg_cron schedule; verify the actual database job.
- Outreach: the local Codex automation service or a foreground user request starts a bounded coordinator. Live definitions, status, and private checkpoints are outside Git and are not installed by `npm ci`.

## Validation and release

```bash
npm test
npx tsc --noEmit
npm run check:production-source
npm run build
```

Review migrations separately for schema changes. The build generates art; inspect the resulting tree so unexpected generated files do not ship.

Existing production is linked to `armansra-hub/stanley`, `main`. Push reviewed, validated commits through that Git integration. Never replace production with `vercel --prod`, a directory upload, or prebuilt output. Set `STANLEY_PRODUCTION_SOURCE_POLICY=github-main-only-v1` only in Production; leave it blank locally and in Preview.

After deployment, verify its immutable commit, GitHub repository, `main` branch, and `src=git` using Vercel deployment metadata. The authenticated `/api/agent/contract` also reports source attestation, but a local guard pass does not prove the served deployment. Do not report production synchronized if only the Git push was verified.

For rollback, review code/schema/data compatibility first. Prefer a reviewed Git revert through the same pipeline; do not force-push history or silently restore business records.

## Keeping the handoff current

Update architecture when score contracts, source gates, schedules, or workflow boundaries change. Update `.env.example` with new settings. Refresh selected local reference files and their hash manifest when the canonical files change. Keep reconciliation reports explicit about compared sources and verified external states.
