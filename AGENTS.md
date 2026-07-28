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
where the token is `AGENT_TOKEN` (falls back to `CRON_SECRET`). Identify yourself
with `x-agent-name: codex`.

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
| `GET /api/agent/read?table=…` | **Read any business table** — full PostgREST filters. Call bare to list tables. |
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
  -d '{"title":"Regrade TAM from records","total":7402,"note":"batch 1"}'

# update (repeat as you progress)
curl -X POST $BASE/api/agent/status -H "x-agent-token: $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"taskId":"<id>","done":1200,"note":"batch 6 of 30"}'
```

### Read anything

You have read access to all of Stanley's business data — companies, triggers,
exports, app_events, score_snapshots — through one endpoint, with the full
PostgREST filter language:

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
GET-only over an allowlist, so your token sees everything and can destroy nothing.
Writes go through the specific endpoints below, which enforce Stanley's rules.

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
blank. **A bad row no longer kills the batch** — it comes back named, with the
value received, and its neighbours still write.

---

## Rules that are not yours to override

1. **`tam_score` is a 0-100 close probability, honestly calibrated.** The median
   real grade is single digits and ≥60 is rare. Never rescale, never curve, never
   assume a low number is a bug.
2. **`oldgold_score` is derived, never copied.** It equals `tam_score` only when the
   row has *both* a qual note and a last SQL date; otherwise `null`. The bridge
   enforces this.
3. **Hard zeros stand.** `record_dead` rows and NetSuite incumbents score 0 no
   matter what a grade says. The bridge enforces this too.
4. **Duplicate NetSuite internal IDs exist** (~20). Anything whose value depends on
   the row must be written per company row, not per internal ID.
5. **Push the RAW grade. Stanley's signal layer is applied for you, on every write.**
   Division of labour: **Codex owns the grade** (TAM + Old Gold, read from the
   record). **Stanley owns the signals** — triggers from the daily sweeps, DOL-5500
   headcount growth, PE ownership, competitor-ERP detection. `/api/agent/scores`
   stores your number in `codex_score` and re-derives `tam_score = your grade ±
   live signals (capped ±15)` at write time, so a regrade can no longer erase that
   layer (it did on 7/15). Don't fold Stanley's signals into your own number.
   Each signal *type* counts once, at its strongest — repeated reports of one event
   don't compound; stacking happens across different types.
6. **Omit what you don't mean to change.** A field you leave out is left alone —
   notably `recordDead`. Sending nothing is how you say "unchanged"; sending `false`
   is how you say "bring this lead back".
7. **Never delete leads.** Removed-from-TAM leads are hidden, never dropped; their
   grades, digests and history are kept. Target Account List rows never disappear.
8. **Push text, not PDFs.** Free-tier Supabase is 500MB; the PDF corpus is ~15GB.
   Extracted text for the whole TAM is ~100MB and is what a grader actually reads.

---

## What already happened (read before regrading anything)

- **The 2026-07-15 full-record regrade already landed.** 6,912 of 7,402 TAM leads
  (93.4%) carry it right now, with rationale in `record_digest`. It went in through
  a `/api/import/scores` route that was deleted the same evening — which is why
  nothing has landed since. **Check what exists before regrading from scratch:**
  `GET /api/agent/contract` reports the counts.
- **~490 TAM leads never got that pass.** That gap, not the whole TAM, is the real
  remaining work.
- **That import overwrote Stanley's signal adjustments** (`tam_score` was set equal
  to `codex_score`). Re-running `system/codex_rescore.py` restores them.
- **Why the old import broke:** an omitted `revisitOn` is `undefined`, not `null`, so
  a strict `/^\d{4}-\d{2}-\d{2}$/` test rejected entire 250-row batches with no row
  index. Fixed here — dates are tolerant and errors are per-row.
- **The browser is for truncated records.** Some PDFs cut long fields off with
  "(see more…)", and those leads genuinely need the NetSuite UI to grade honestly —
  that is why Codex drives Chrome, and it should keep doing so for them. For the
  rest, the local PDFs are enough: the 7/14 run extracted 7,130 leads — 109,293
  pages, 947M characters — in **33 minutes** on 8 workers. **Split the list before
  grading** (agreed 7/27): grade from local PDF text wherever the record is complete,
  and reserve the browser for the truncated ones. Only you can tell which is which.

---

## Repo conventions

- Next.js App Router + Supabase. `npx vitest run` and `npx tsc --noEmit` must pass.
- Migrations live in `supabase/migrations/NNNN_name.sql`, applied in order by
  `system/apply_migrations.py` (Claude runs these; don't apply DDL by hand).
- Server-only DB access goes through `serviceClient()` in `lib/supabase/server.ts`.
- Log anything notable to `app_events` via `logEvent()` — it's the shared timeline
  both agents and Arman read to understand what happened.
- One branch, `main`, deployed by Vercel on push. Both agents write to it, so keep
  changes small and don't refactor across the other's work in flight.
