# Saved Codex automations

[Catalog home](README.md) · [Coverage](workspace-coverage.md)

Snapshot: **2026-09-11**. Six local `automation.toml` definitions were present, all marked `ACTIVE`. That label describes saved configuration. This inventory did not execute jobs, check every latest outcome, modify schedules, or confirm reminder delivery. Times below are **America/Los_Angeles (Pacific)**.

| Automation | Saved schedule | Execution and dependencies | Catalog |
|---|---|---|---|
| Morning Sales Focus | Weekdays, 08:00 | Local cron in Sales hub; calendar, Outlook, Slack, bounded cursors; read-only | [SK05](personal-skills.md#sk05) |
| Sales Day Recap | Weekdays, 16:30 | Local cron in Sales hub; reuse morning evidence, inspect deltas and upcoming calendar; read-only | [SK06](personal-skills.md#sk06) |
| Outlook Outreach Cadence Manager | Weekdays, 09:00 and 17:00 | Local cron in Sales hub; private cadence policy/ledger, existing Outlook web Chrome, independent Sent readback, NetSuite touches | [SO02](sales-operations.md#so02) |
| Monday Morning TAL Touch | Monday, 10:30 | Local cron in Stanley; event/ZoomInfo research, MMTT batch state, explicit batch approval, approved delivery and touches | [SO05](sales-operations.md#so05) |
| TAL LinkedIn outreach and cadence | Daily, 07:00 | Local cron in Stanley; additional weekday and 06:45–08:15 execution gates, canonical locks, exact-profile provenance and CRM eligibility | [SO07](sales-operations.md#so07) |
| One-time deal follow-up reminder (public alias) | One occurrence, 09:00; created September 9 | Thread heartbeat; private reminder text withheld. ACTIVE does not mean an ongoing daily reminder or an undelivered reminder. | [SK07](personal-skills.md#sk07) |

The two daily briefing definitions select `gpt-5.6-luna` with low reasoning; the three operational cadence/event definitions select `gpt-5.6-sol` with medium reasoning. These are the saved local settings on the snapshot date, not model recommendations or evidence that every recorded run used those settings. No model setting is inferred for the one-time heartbeat.

## Configuration drift found during inventory

1. **MMTT recipient count:** the saved scheduler prompt still contains a three-person in-person-company gate. Current standing instructions and the public workflow handoff say there is **no minimum recipient count**. The newer standing instruction governs; the old scheduler phrase is not the current business rule.
2. **LinkedIn days:** the schedule fires daily, while the policy restricts action to weekdays. A weekend invocation must exit at the policy gate; a daily trigger does not authorize weekend outreach.
3. **MMTT delivery language:** the private policy still contains older Tuesday scheduling/Scheduled-item language alongside current no-Send-Later rules. This was already documented in the [local workflow handoff](../operations/README.md). No retired delivery path was activated or silently selected by this catalog update.

These definitions were inventoried without changing the running sales system. Resolve an affected execution plan against current instructions and exact approval before performing business writes.

## Historical schedules

| Historical item | Evidence and current interpretation |
|---|---|
| Sales Nav Upload Continuation Agent | The task's final result confirms deletion. No current definition exists. The manual upload skill and checkpointed CSV workflow remain. |
| Earlier every-other-day LinkedIn outreach | Historical task identifier precedes the current LinkedIn coordinator. Do not start a second coordinator from an old prompt. |
| BDR Slack coordination experiment | Historical scheduled-message work, including an unresolved cancellation-verification outcome. No matching current Codex recurring definition was found. |

Recurring Missions inside Stanley and the hosted hourly Vercel ingestion rotation are application features, not additional local Codex automation definitions. Scheduled Outlook delivery is also distinct from a Codex schedule and is not an authorized substitute for the current Outlook workflow.
