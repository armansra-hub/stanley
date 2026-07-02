# Stanley (codebase: `jarvis`)

All-in-one assistant for a solo NetSuite account executive. Three **live** modules
sharing one Next.js app + Supabase DB:

| Module | Route | What it does |
|---|---|---|
| **Headhunter** | `/headhunter` | Watches the AE's TAM like a hawk for ERP-readiness trigger events and ranks the "call these now" worklist |
| **Missions** | `/missions` | Voice/chat tasks + calendar agent (confirm-before-apply) |
| **Kill List** | `/kill-list` | Manual pipeline Kanban with a task↔Missions bridge |

> Externally branded **Stanley**; the codebase/dirs stay `jarvis`. Single-user
> password gate (middleware) when `APP_PASSWORD` is set; open in local dev.

## Headhunter — the model

**Pure TAM monitoring, no discovery.** The AE uploads his TAM as CSVs — the
NetSuite export (the *claimable* universe + source of truth) plus ZoomInfo lists —
into a silo/**list** model (`lists[]` on each company; additive re-uploads +
deliberate prune; hard industry blocks enforced at import). The engine then
monitors the whole base for trigger events and ranks them.

**Tabs:** 🔥 **Triggered** (live events, ranked by decayed trigger strength ×
fit × multi-signal/QuickBooks/PE bonuses) · 🪙 **Old Gold** (mines the NetSuite
qualification notes + lead records for revival timing — "has their stated future
arrived?") · **TAM Base** (the full server-paged base with tag/claimable/ERP
filters) · ★ **Starred** · **Export History**. Exports: full CSV or the NetSuite
saved-search SQL formula (copy-paste only — Stanley never calls a NetSuite API).

### Signal roster (all verified against this base; failures were killed)

| Signal | Source | Cadence |
|---|---|---|
| News events (funding / acquirer-M&A / new entity / expansion) | Google News per company; regex prefilter + **Opus 4.8 verifier** on claimable (budget-gated, ≤$10/wk) | daily |
| Finance-leader hire announced | targeted Google News (CFO/Controller/VP Finance) | daily |
| Finance role posted (own careers page; staffing client-boards filtered out) | website watch | daily rotation |
| Website growth phrases + newsroom/blog RSS | company site diffing | daily rotation |
| Parent-company detection (auto-dismiss high-confidence subsidiaries; toggle) | company site | daily rotation |
| Fleet + driver growth (transportation) | FMCSA census snapshots | daily |
| New subsidiary/entity + UCC-1 financing (CO pilot) | CO Secretary of State open data | daily |
| SBA 7(a)/504 growth loans (all states) | SBA FOIA files → `scripts/ingest_sba.py` | quarterly |
| Headcount growth % + crossed-50-employees (ACA ALE threshold) | DOL Form 5500 (SF + full) → `scripts/refresh_headcount.sh` | monthly |
| TAL (claimed-accounts) news → 🔔 in-app alerts | Google News, highest priority | daily |

Reliability: one consolidated Vercel cron (16:00 UTC) fans out ~75 isolated
waves; every sweep is time-boxed and stamps progress incrementally (a timeout
never loses work); a daily recompute drops decayed "ghost" leads and rescues
"zombie" ones; exported leads **resurface automatically** when a genuinely new
trigger lands >14 days after export (dismissed never does).

### Hard rules
- **Never fabricate a signal** — every trigger/signal row carries a real `source_url`.
- **NetSuite export = source of truth**; it overrides firmographics on merge.
- **Blocked**: accounting/tax, law/legal, pure 3PLs, call centers, government entities.
- **Growth-positive only**: layoffs and office *moves* are excluded; getting
  *acquired* is not a signal (only *acquiring* is).
- No auto-actions on signals (no Missions creation, no email — in-app only).
- Company-level only; no contact reveal. Budget ≤$10/week.

## Quick start (fork & run)

Prereqs: **Node ≥ 20**, a free **Supabase** project, an **Anthropic** API key.

```bash
npm install
cp .env.example .env.local      # fill in values (comments in the file)
```

Run the SQL migrations in the **Supabase SQL editor**, in order:
`supabase/migrations/0001_init.sql` … `0030_old_gold.sql`.

```bash
npm run dev                     # http://localhost:3000
npm test                        # vitest — 66 passing, no secrets needed
```

Deploying (Vercel): add the env vars from `.env.example`, set `APP_PASSWORD` +
`APP_SESSION_TOKEN` for the login gate, and the daily cron in `vercel.json`
drives all monitoring. Note `.vercelignore` intentionally ships `public/art/`
(background images) even though git ignores it — drop your own wide images
there (a gradient shows until you do; see `public/art/README.md`).

Data lands via the UI: **+ Base CSV** (vendor picker + list name) for TAM
uploads, **+ TAL CSV** for the claimed-accounts sync. The NetSuite export's
`Qualification Note` + `Last BDR SQL Date` columns feed Old Gold.

### Offline data scripts (`scripts/`)

| Script | What | Re-run |
|---|---|---|
| `refresh_headcount.sh [years…]` | DOL 5500 download + both ingests (headcount % merge-max + ACA-50 triggers) | monthly |
| `ingest_sba.py` | SBA 7(a)/504 loan triggers (name+state matched) | quarterly |
| `ingest_dol5500.py` / `_full.py` | the two 5500 ingests (called by the refresh script) | — |
| `backfillInternalId.ts` | re-run a NetSuite CSV to backfill internal IDs | as needed |

All are deduped and safe to re-run; they read creds from `.env.local` and call
the deployed `/api/cron/recompute` so new triggers rank immediately.

## Stack & thesis

Next.js (App Router) + TypeScript + Tailwind · Supabase Postgres (service-role,
server-only) · Anthropic SDK (**Opus 4.8**: news verifier, Old Gold analysis,
chat) · Web Speech API voice · Vercel (single daily cron; every sweep its own
60s function).

**The thesis:** NetSuite wins when operational/financial complexity outgrows
QuickBooks — multi-entity, multi-location, project costing, rev-rec,
audit/compliance. Every signal is a proxy for a complexity spike; every kill
(ATS 0/60, federal contracts 0/150, Form D 0/150, H-1B 0.6%, USPTO, FCC ~3%)
was an empirical dry-match against this specific small-private-company base.
Show-me-the-match-rate before building is the house rule.
