# Stanley — instructions for agents

Stanley is Arman's prospecting suite for a solo NetSuite AE working the Business
Services territory. Two agents work on it, and this file is the contract between
them. Read it before changing anything.

- **Codex** (OpenAI, cloud, with its own browser) — drives NetSuite, ZoomInfo,
  LinkedIn and Sales Navigator; grades leads from the record; claims leads.
- **Claude Code** (Anthropic, local on the Mac) — owns this repo, the Supabase
  migrations, the python pipeline in the dataset dir, monitoring, and grading passes.

Neither agent can see the other's session. **The bridge below is how you talk.**

---

## The bridge: `/api/agent/*`

Base URL: `https://jarvis-sable-eta.vercel.app`

Auth on every call — `Authorization: Bearer <token>` or `x-agent-token: <token>`,
where the token is the dedicated server-only `AGENT_TOKEN` (or the separately
rotated `CODEX_AGENT_TOKEN`). `CRON_SECRET` and URL query tokens are never accepted.
Identify yourself with `x-agent-name: codex`.

```bash
# What is this bridge, what endpoints exist, what's the current state?
curl -H "x-agent-token: $TOKEN" $BASE/api/agent/contract
```

| Endpoint | Use it for |
|---|---|
| `GET /api/agent/contract` | The whole protocol + live counts. Start here. |
| `GET /api/agent/messages?to=codex&unread=1` | Read your inbox. Add `&peek=1` to leave unread. |
| `POST /api/agent/messages` | Leave a note: `{to, subject, body?, kind?, ref?}` |
| `GET/POST /api/agent/status` | The live board — what you're working on, how far along |
| `GET /api/agent/read?table=…` | Read allowlisted tables/columns with scalar PostgREST filters. Relationship embeds and aliases are rejected. |
| `GET /api/agent/lead?internalId=…` | Everything about one lead in one call |
| `POST /api/agent/documents` | Push lead record **text** (max 200/request) |
| `POST /api/agent/scores` | Push grades (max 1000/request, **`dryRun` first**) |

### Say what you're doing

Long jobs must heartbeat, so "still working" and "silently stalled" stop looking
the same. Open a task, update it as you go, close it when done:

```bash
# open → returns taskId
curl -X POST $BASE/api/agent/status -H "x-agent-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Regrade TAM from records","total":6949,"note":"checkpoint seed"}'

# update (repeat as you progress)
curl -X POST $BASE/api/agent/status -H "x-agent-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"taskId":"<id>","done":1200,"note":"batch 6 of 30"}'
```

### Read allowlisted business data

You have read access to explicitly allowlisted tables and scalar columns — such
as companies, triggers, exports, app_events, and score_snapshots — through one
endpoint. Scalar PostgREST filters and ordering are supported; relationship
embeds, aliases, spreads, casts, JSON paths, and computed selects are rejected:

```bash
curl -H "x-agent-token: $TOKEN" \
  "$BASE/api/agent/read?table=companies&select=name,tam_score,codex_score&tam_score=gte.40&order=tam_score.desc&limit=25"

# which TAM leads still have no grade?
curl -H "x-agent-token: $TOKEN" \
  "$BASE/api/agent/read?table=companies&select=netsuite_internal_id,name&netsuite_internal_id=not.is.null&codex_score=is.null&limit=1000"

# everything about one lead at once
curl -H "x-agent-token: $TOKEN" "$BASE/api/agent/lead?internalId=92847818"
```

The database key is not shared with either agent, by design: `/api/agent/read` is
GET-only over table and scalar-column allowlists, so the token cannot traverse
into coordination claims/seeds or mutate data. Writes go through the specific
endpoints below, which enforce Stanley's rules.

### Push grades

Always dry-run first — it reports matches, misses, and bad rows without writing.

```bash
curl -X POST $BASE/api/agent/scores -H "x-agent-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"dryRun":true,"label":"regrade-2026-07","rows":[
        {"internalId":"92847818","tamScore":12,"recordDigest":"…","recordDead":false}]}'
```

Only `internalId` and `tamScore` are required. Field names are matched loosely
(`internalId` / `internal_id` / `nsid` / `"Internal ID"`; `tamScore` / `score` /
`grade`). Dates accept `YYYY-MM-DD`, `M/D/YYYY`, ISO timestamps, Excel serials, or
blank. A preflight-detectable bad row comes back named and is excluded while its
safe neighbours still write. The database then revalidates the retained set under
row locks and rolls the whole atomic batch back if locked state has changed.

---

## Rules that are not yours to override

1. **`tam_score` is a 0-100 close probability, honestly calibrated.** The median
   real grade is single digits and ≥60 is rare. Never rescale, never curve, never
   assume a low number is a bug.
2. **Old Gold artifacts and live storage have different jobs.** Every current
   assessment artifact includes `old_gold_score`, `old_gold_class`,
   `intro_call_exists`, and `opportunity_exists`, including a supported
   `old_gold_score: 0` for a non-member. Live `companies.oldgold_score` is a
   worklist-membership value: it is `null` when that exact company row lacks the
   required qual-note/prior-SQL pair or an audited dated opportunity. A qualifying
   row stores the independently graded revival score (falling back to its TAM grade
   only when no independent revival score was supplied). The bridge enforces this.
3. **Hard zeros stand.** `record_dead` rows and NetSuite incumbents score 0 no
   matter what a grade says. The bridge enforces this too.
4. **Historical duplicate NetSuite rows exist** (~20 pairs). Rows tagged
   `tam_duplicate` are immutable audit history; an exact-ID write targets the sole
   canonical row, and any other ambiguity fails closed.
5. **Push the RAW record grade; signals never alter it.** `/api/agent/scores`
   stores the raw number in `codex_score`. `tam_score` equals that number except
   for the record-derived hard zeros in rule 3. Public intelligence — trigger
   sweeps, headcount growth, PE ownership, and other scraped facts — ranks only
   the separate Triggered worklist. Never fold it into TAM or Old Gold, and never
   run a backfill that adds a public-signal delta to either score.
6. **Omit what you don't mean to change.** A field you leave out is left alone —
   notably `recordDead`. Sending nothing is how you say "unchanged"; sending `false`
   is how you say "bring this lead back".
7. **Never delete leads.** Removed-from-TAM leads are hidden, never dropped; their
   grades, digests and history are kept. Target Account List rows never disappear.
8. **Keep PDF binaries in the verified local evidence corpus.** The current exact
   PDF set is 1.729GB, above Supabase Free Storage's 1GB quota. Never upload that
   corpus to the app or create a production bucket for it. The coordinator stores
   only a relative local locator, SHA-256, page count, and verification timestamp;
   its bootstrap importer must re-open the local file and prove those values.
   Share full extracted record text through the existing private document bridge.

---

## What already happened (read before regrading anything)

- **The current membership checkpoint is exact and immutable.** NetSuite saved
  search `1327786` (`ARS BS TAM`) produced 7,618 saved-search rows, 6,949 distinct
  current Internal IDs, and 669 preserved duplicate row occurrences. The canonical
  membership SHA-256 is
  `61708344dd9527141401c1b61dd36cc08c185d0efd418426f982364ed118bbfa`; the source
  snapshot SHA-256 is
  `1a539c7e3ffe8af9b44aa4e7d120449e6e7aed9f6932137caa7268da6993156e`.
  Do not substitute a Stanley table count, an older export, or a newly scraped list.
- **The current exact-ID PDF corpus is complete.** It covers all 6,949 current IDs,
  90,857 pages, and 1,728,918,143 bytes. The ordered current exact-ID set
  SHA-256 (`Internal ID + LF` in canonical numeric order) is
  `2294caa9c38d2302437a8fda18c54316c3416695d21871fd4b3ea9c6e58c7de9`.
  Register only locally reverified evidence through the trusted importer.
- **There are 4,936 staged current finals, but only 2,696 satisfy the complete
  current schema.** The aggregate SHA-256 is
  `50586b401e3c455260bb90436b6bbcf43d049e8272750c14d83c1dd39344c0c1`.
  The mandatory recovery order is 2,240 legacy incomplete finals, then three
  lost-staging current IDs (`192808358`, `192911789`, `192919485`), then 49 active
  holds, then 1,961 genuinely unrepresented current IDs. Never skip ahead while an
  earlier cohort remains claimable.
- **Seed and verify the coordination checkpoint before either agent claims work.**
  Expected current state is 6,949 records: 2,696 published, 4,204 pending, 49 hold,
  and zero reading/final/expired. Including 34 historical removed records, the run
  contains 6,983 records. A count, cohort hash, or exact-ID mismatch is a release
  stop, not permission to repair ad hoc.
- **The former outside-signal score layer was retired on 2026-08-10.** Current
  non-dead grades were normalized so `tam_score = codex_score`; record-dead rows
  and confirmed NetSuite incumbents retain their hard zero. Signals belong only
  in Triggered. Do not restore or recreate a signal delta on TAM or Old Gold.
- **Name-only SEC Form D matching is retired.** A normalized legal-name match,
  even with an exact filing URL, cannot distinguish every same-named issuer. New
  Form D triggers remain disabled and prior rows remain hidden/quarantined until
  a future path binds a second stable identifier or location. Never re-enable
  substring or name-only attachment.
- **The legacy name-only USAspending writer is retired.** Verified federal-award
  signals must use the government-entity bindings in `/api/cron/public-growth`.
  Prior `gov_contract`/USAspending rows are hidden and quarantined; never restore
  substring recipient matching.
- **Why the old import broke:** an omitted `revisitOn` is `undefined`, not `null`, so
  a strict `/^\d{4}-\d{2}-\d{2}$/` test rejected entire 250-row batches with no row
  index. Fixed here — dates are tolerant and errors are per-row.
- **Use the full local evidence first and fail closed on truncation.** The current
  exact-ID package, not the superseded 7/14 corpus, is the baseline. If verified
  record text contains a truncated field needed for judgment, use the authenticated
  NetSuite record for that exact ID and record the supplemental provenance; never
  infer the hidden text or silently grade around it.

---

## Repo conventions

- Next.js App Router + Supabase. `npx vitest run` and `npx tsc --noEmit` must pass.
- Migrations live in `supabase/migrations/NNNN_name.sql`, applied in order by
  `system/apply_migrations.py` (Claude runs these; don't apply DDL by hand).
- Server-only DB access goes through `serviceClient()` in `lib/supabase/server.ts`.
- Log anything notable to `app_events` via `logEvent()` — it's the shared timeline
  both agents and Arman read to understand what happened.
- One canonical production source: GitHub `armansra-hub/stanley`, branch `main`,
  deployed by Vercel's Git integration on push. Both agents write to it, so keep
  changes small and don't refactor across the other's work in flight.
- **Never run `vercel --prod` (or any CLI deploy).** Ship by pushing to `main`; the
  git integration deploys in under a minute. A CLI deploy uploads whatever files sit
  in a local folder and takes over the production alias, so `main` stops describing
  what production runs. That is not hypothetical: repeated `src=cli` deploys between
  2026-08-03 and 2026-08-10 kept the July 29 news name-match guard and the
  queue-for-review gate off in production for ~2 weeks, and 245 mis-attributed news
  triggers reached the Triggered tab as a result. If you think you need a CLI deploy,
  ask Arman first. The repository's prebuild guard and `.vercelignore` are
  defense-in-depth, not the authority: Vercel can deploy prebuilt output outside
  the repository build. Keep `STANLEY_PRODUCTION_SOURCE_POLICY=github-main-only-v1`
  scoped to Production, restrict production deploy/promotion authority in Vercel,
  and block release unless the served deployment readback shows exact commit,
  GitHub repository, `main` branch, and `src=git`. Check with
  `vercel inspect <deployment-url>` or the equivalent Vercel deployment API.
