# Personal skills and daily coordination

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Custom instruction packages and locally configured scheduled tasks.

<a id="sk01"></a>

## SK01 — Arman Sales Ops personal plugin

**Status:** Source present. **Purpose:** Package reusable sales operating methods for Codex.

**How it works:** A personal plugin manifest groups three skills: daily triage, account qualification, and action preparation. Reference contracts standardize evidence, decision gates, and outputs. An audited colleague fork informed the design; the personal plugin is the user-created adaptation.

**Infrastructure:** Local .codex-plugin/plugin.json, Markdown skills/references, agent descriptors, personal marketplace registration.

**Evidence:** Private: plugins/arman-sales-ops, 10 source files; personal marketplace entry; Audit fork for workflows completion. Source and registration found; current session exposure is not asserted.

**Sharing:** Private source or artifacts; public description only.

<a id="sk02"></a>

## SK02 — Triage Sales Day skill

**Status:** Source present. **Purpose:** Produce a compact, evidence-based daily action list.

**How it works:** Use bounded calendar, Outlook, Slack, and relevant deal context; merge duplicate signals; distinguish Now, Today, Waiting, Blocked, and FYI. Preserve source/date/status/next action and missing validation; return at most five actions. Read-only by default.

**Infrastructure:** Arman Sales Ops Markdown skill and operating-doctrine reference; connected read surfaces.

**Evidence:** Private: plugins/arman-sales-ops/skills/triage-sales-day/SKILL.md and references/operating-doctrine.md.

**Sharing:** Private source or artifacts; public description only.

<a id="sk03"></a>

## SK03 — Qualify Sales Account skill

**Status:** Source present. **Purpose:** Decide whether an account is actionable from verified evidence.

**How it works:** Resolve name/domain identity before firmographics and CRM ownership/customer/duplicate/opportunity checks. Separate verified facts, inferences, and unknowns; produce a primary status and next action. Missing authoritative evidence stays blocked rather than guessed.

**Infrastructure:** Arman Sales Ops skill with qualification-contract reference; authorized research/CRM reads.

**Evidence:** Private: plugins/arman-sales-ops/skills/qualify-sales-account/SKILL.md and references/qualification-contract.md.

**Sharing:** Private source or artifacts; public description only.

<a id="sk04"></a>

## SK04 — Prepare Sales Action skill

**Status:** Source present. **Purpose:** Convert current account context into a reviewable next action.

**How it works:** Prepare meeting briefs, follow-ups, outreach, contact QA, account plans, internal coordination, or CRM-ready notes. Validate identity, separate facts from interpretation and proposed copy, and expose missing information. Preparation does not itself execute the action.

**Infrastructure:** Arman Sales Ops skill and action-packet reference; task-specific research sources.

**Evidence:** Private: plugins/arman-sales-ops/skills/prepare-sales-action/SKILL.md and references/action-packet.md.

**Sharing:** Private source or artifacts; public description only.

<a id="sk05"></a>

## SK05 — Morning Sales Focus

**Status:** Configured. **Purpose:** Provide a small morning list of actionable changes.

**How it works:** Use calendar and cursor-based Outlook/Slack deltas, open exact items only as needed, merge duplicate signals, and return at most five priorities. Save compact cursor/receipt state and exit when unchanged. No browser or external writes.

**Infrastructure:** Weekdays 08:00 Pacific; Codex local cron; Sales hub policies and read connectors.

**Evidence:** Current morning-sales-focus definition and dated Sales hub run receipts.

**Sharing:** Private source or artifacts; public description only.

<a id="sk06"></a>

## SK06 — Sales Day Recap

**Status:** Configured. **Purpose:** Close the day with unresolved actions and near-term preparation.

**How it works:** Reuse morning evidence/cursors, inspect changes and calendar through the next two days, and produce at most seven actions. Mark unavailable CRM validation explicitly. Save a bounded receipt; no browser or external writes.

**Infrastructure:** Weekdays 16:30 Pacific; Codex local cron; Sales hub context.

**Evidence:** Current sales-day-recap definition; SALES_NOTIFICATION_TASKS.md; dated recap receipts.

**Sharing:** Private source or artifacts; public description only.

<a id="sk07"></a>

## SK07 — One-time deal follow-up reminder

**Status:** Configured. **Purpose:** Recall a specific user-requested follow-up at a scheduled time.

**How it works:** A one-occurrence heartbeat stores the requested reminder in the original task. An ACTIVE definition is not proof that a reminder remains pending or that it recurs indefinitely. Recipient and private deal content are withheld.

**Infrastructure:** Codex thread heartbeat; local automation definition with one occurrence.

**Evidence:** One saved reminder definition created 2026-09-09; metadata checked 2026-09-11. Notification delivery was not audited.

**Sharing:** Private source or artifacts; public description only.
