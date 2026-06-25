# Jarvis — Prospecting module (v1)

All-in-one assistant for a NetSuite account executive. Three planned modules —
**(1) Prospecting**, (2) Reminders, (3) Pipeline tracker. This repo builds the
**Prospecting** module first, architected so the other two slot in later as
sibling modules sharing the same Supabase DB + auth.

Prospecting finds **in-territory companies showing growth signals**, scores
them, shows them on a dashboard, and lets you select + export them to NetSuite
(copy-paste only — Jarvis never calls a NetSuite API).

## Hard rules
- **Never fabricate a signal.** Every `signals` row carries a real `source_url`.
- **Subindustry is the hard territory gate.** Out-of-territory companies never
  reach the dashboard.
- **States hard-filter only Google Maps results** (location verifiable there);
  other sources aren't geo-gated. Revenue/employee bands are display-only.
- **Dedupe on normalized domain.** Once exported, a company never resurfaces as new.
- **No outreach drafting in v1.** Discovery → scoring → export only.

## Stack
Next.js (App Router) + TypeScript + Tailwind · Supabase (Postgres + Auth) ·
Apify (config-driven actor IDs, pay-per-result) · Anthropic SDK
(`claude-haiku-4-5` bulk classify/score, `claude-opus-4-8` chatbot) ·
Web Speech API for voice. Deploy on Vercel; discovery runs on a cron/webhook,
never in the request path.

## The thesis (drives signal selection)
NetSuite wins when operational/financial complexity outgrows QuickBooks. Every
signal is a proxy for a spike in one of six complexity drivers: **multi-entity,
multi-location, multi-currency, project/job costing, revenue recognition,
audit/compliance**. Detect the event (new subsidiary, M&A, funding, gov
contract, new warehouse, fleet growth, finance-leader hire, "transitioning off
QuickBooks" job post) → infer the driver → score it. Subindustry-specific events
outrank generic growth. Full map in `config/signals.ts`.

## Scoring (both shown, per build decision)
- **Deterministic `signal_score` 0–100** — capped sum of tunable signal weights
  (`scoring_weights` table). AI is *not* involved.
- **LLM `score_tier` A/B/C** — independent model judgment per the rubric.
Both render side by side; the detail drawer lists every signal, leading with the
strongest.

## Territory
24 ZoomInfo subindustries across 4 buckets; 32 regions (25 US states, 5 Canadian,
2 US territories). Canonical copy: [`config/territory.ts`](config/territory.ts);
DB seed: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

## What's built so far
- `lib/domain.ts` — domain normalizer (shared dedupe key + SQL export input).
- `lib/export/sql.ts` — NetSuite `Formula (Numeric)` chunker (≤40 domains/chunk).
- `lib/export/csv.ts` — two-column CSV exporter.
- `supabase/migrations/0001_init.sql` — full schema + seed.
- `config/signals.ts` — the thesis + signal catalog (every buying-trigger event → signal → how to catch it), complexity drivers, per-vertical job-post + news trigger dictionaries.
- `config/sources.ts` — FREE source catalog: SEC EDGAR Form D, Google News + Business Wire / GlobeNewswire / PR Newswire RSS, **FMCSA Motor Carrier Census** (new authority + fleet growth), **USASpending.gov** (gov-contract wins), **Inc. 5000** (fast-growth list), OpenCorporates (new entities).
- `config/territory.ts`, `config/actors.ts`, `config/news.ts` — territory, the 9 paid Apify actor slots, free news/PR feeds.

Run the deterministic-core tests (no install, no secrets needed — Node ≥ 22):

```bash
npm test        # node --test  → 11 passing
```

## Still to build
Next.js app shell + dashboard (on seed data) → free sources (EDGAR Form D,
Google News RSS) → Apify actors → AI classify/score/summary → CSV-upload mode →
voice + chatbot (confirm-before-apply) → Vercel cron/webhook scheduling.

## To go live you'll provide
- Supabase project URL + anon key + service-role key.
- `ANTHROPIC_API_KEY`.
- `APIFY_TOKEN` + the 7 Apify actor IDs (google_maps, crunchbase,
  linkedin_company, hiring_monitor, ats_aggregator, linkedin_jobs, indeed).
See [`.env.example`](.env.example) and [`config/actors.ts`](config/actors.ts).
