# Local Stanley workflows

Reviewed 2026-09-09. These workflows run in the operator's local workspace and authenticated Chrome session. They are not Vercel cron workers and are not installed or activated by cloning this repository.

This guide summarizes the current business rules without publishing customer information or live schedules. Canonical private policies remain authoritative for execution, together with the operator's latest instructions. [reference/](reference/README.md) contains selected actual source files; [source-manifest.json](source-manifest.json) records their origin and hashes.

## Runtime contract

One coordinator owns the browser lease, workflow lock, exact-item state, and external action sequence. Scheduled invocations are finite, checkpointed passes. An explicitly authorized completion run continues through its safe bounded worklist; checkpoints do not imply the work is complete.

Load a bounded state snapshot and the exact next record. Verify identity and current eligibility, persist an intended action before the external write where required, confirm the external result, and checkpoint immediately. Reconcile uncertain writes before any retry. Never retry an accepted email whose delivery verification is inconclusive. Use one evidence-based UI recovery; persistent failure becomes an exact-item blocker.

Reuse the operator's existing ungrouped Chrome tabs, one per external application. Acquire the cross-workflow browser lease before initializing control, heartbeat before writes, and release it at exit. A separate LinkedIn lock prevents overlapping coordinators. No tab groups, blind polling, background queue drains, or uncontrolled helper relaunches. Return focus to a previously active YouTube playback tab when required by the operator's handoff rule.

Save a compact receipt distinguishing attempted and externally confirmed actions, pending CRM touches, blockers, checkpoint identity, and stop reason. Verify canonical state integrity and clean up helper runtimes.

## Outlook prospecting cadence

The private authority is `Sales hub/OUTLOOK_CADENCE.md`. The canonical ledger is `outlook_cadence_state.json`; read bounded slices using `outlook_cadence_state_fast.py`.

| Step | Eligibility |
|---|---|
| Initial | Approved copy, exact recipient, current qualification, suppression and duplicate checks |
| Follow-up 1 | Second business day after initial |
| Follow-ups 2–4 | Next business day after the preceding verified send |
| Complete | Follow-up 4 and required CRM touch verified |

Follow-ups are due at 9:00 AM America/Los_Angeles, skipping weekends and U.S. federal holidays. A qualifying manually sent introduction can be enrolled by the read-only Sent Items audit. Exact message IDs and timestamps establish the anchor.

Every initial template uses `Do you have time for a 15-minute meeting this/next week?` unless explicitly overridden for that message. New messages and replies use the existing Outlook web tab in external Chrome. Connectors are for reads and independent verification, not sends or drafts. Replies must open the exact validated thread, use **Reply All**, and visibly preserve the quoted conversation.

Outlook supplies the configured signature exactly once. Type only prospect-facing copy above it; never reconstruct the signature. Re-rendered editor blocks require exact copy/order/count checks. The included guards implement particular initial/FU1 checks; they do not replace recipient, thread, other-step, or signature UI verification.

Persist `pending_action` using a stable cadence/step key before send. Require exactly one matching new Sent Item, then save its immutable message ID. Inconclusive accepted sends become `verification_pending` and must not be retried automatically.

Replies and automatic responses pause the exact contact, not coworkers. A known out-of-office return date moves that person's next eligibility to the first business weekday after return. Bounces, unsubscribe, and contact DNC stop that contact permanently. An explicit company DNC blocks all verified company contacts. Preserve records for audit and deduplication.

Every verified outbound email requires one NetSuite activity per recipient with `TAL Email` and the exact cadence subject. Use the exact correct company; the optional Contact field need not equal the recipient. Commit the dropdown selection by clicking neutral space, then verify the value before saving. Save and verify the activity or keep one deduplicated retry. Never resend an email to repair CRM logging.

## LinkedIn TAL cadence

The private authority is `LINKEDIN_CADENCE.md`; the canonical ledger is `linkedin-cadence-state.json`. Use `linkedin_followup_state_fast.py` for exact slices and gates.

- Weekdays only; one coordinator and both required locks.
- At most nine lifetime automation-generated requests per canonical company, and three per company per local calendar day. Lifetime counters never decrease for declined, withdrawn, expired, or accepted requests. Personal connection activity is excluded.
- Before any outbound action, verify same-day attributable NetSuite ownership, BDR status, LSAD/TAL dates, TAL type, communication evidence, and DNC. SQL, Meeting Scheduled, Rep Engaged, substantive recent communication, or identity uncertainty blocks the account.
- Messaging requires that exact canonical profile URL plus affirmative evidence that this automation sent the request. A connection, pending badge, or name/company match does not establish provenance.
- Inspect the complete available conversation before every message. Any reply permanently stops cadence. Manually owned conversations are skipped.
- The request note is message zero. After acceptance, do not repeat it. Historical note-less requests can receive one initial-message backfill only when provenance and conversation gates pass.
- Follow-up 1 is due the first business day after acceptance (and after later backfilled message zero). Follow-up 2 follows two business days after the prior verified send and is final.
- The foreground phase order is follow-ups, eligible connection work, then NetSuite touch queues. Reserve CRM time when a cutoff applies.
- Every completed block of three requests queues one `LinkedIn connects` activity. Every sent follow-up requires its own `{full_name} - cadence {step}` activity. Touch Type is `TAL LinkedIn Touch`; external save/readback is mandatory.

## Monday Morning TAL Touch (MMTT)

The private authority is `MMTT_POLICY.md`. Read the latest event information in full, verify official event details, and evaluate the current TAL. Use current ZoomInfo evidence for eligible names, titles, emails, and locations; the NetSuite Contacts sublist is not a completeness source.

Eligible titles are C-suite, controllers, vice presidents, and presidents. In-person qualification uses the stated location rules (normally within 100 miles). There is no minimum recipient count and no minimum event lead-time cutoff. Dedupe the exact person against the exact event. Suppression, reply-stop, and approval gates still apply.

Build one complete proposed batch with exact copy and evidence; explicit approval precedes drafts, sends, enrollment, or touches. Send at most one invitation per person per run: primary in-person event where eligible, with at most one brief webinar alternative.

Event cadence has exactly two follow-ups: three business days after the initial anchor, then two business days after the first follow-up, at 9:00 AM Pacific with holiday adjustment. Each requires its own verified CRM touch.

**Known policy inconsistency:** the current MMTT file contains Tuesday scheduling and Scheduled-item enrollment language while both it and the later standing Outlook rules prohibit Send Later. This handoff does not invent a resolution or enable that retired write path. Before executing affected scheduling work, reconcile the exact approved delivery plan with the operator's current instruction; preserve approval, no-duplicate, and touch gates.

## Full-record TAM evaluation

The current local runner is `run_tam_single_record.py`, using `tam_record_core.py`, three reader/validator/chunk schemas, and `stage_tam_final_grades.py`. The copied source shows how it validates full-read artifacts, evidence hashes, a live claim, publication provenance, exact readback, and durable receipts.

One invocation processes one explicit Internal ID with sequential reader and independent validator passes. No retired 16-worker pool, self-relaunch, or polling drain is part of this model. A foreground coordinator can invoke it serially for an explicitly authorized bounded worklist.

The canonical mission, live-state contract, local evidence corpus, and coordination database must agree before execution. They are private and are not bootstrapped by the reference copy. No second membership list, PDF corpus, grading queue, or publish path may be created.

## Research and adjacent browser workflows

Intro-call preparation centers on one researched, subindustry-specific pain hypothesis, clearly separated from verified facts and unknowns. After rapport and an agreed purpose, test it, invite correction, and quantify impact/urgency. Record whether it was validated, disconfirmed, or remains unverified after the call.

The workstation also has separate TAL-gifting and Sales Navigator customer-CSV upload skills. These are operator browser workflows with their own session, evidence, dedupe, and receipt requirements. Their live queues, gift orders, private customer CSVs, and installed skill packages are outside the hosted app and this public handoff.

## Not included

Full private policy files, customer-specific suppressions, recipients, mailbox content, browser state, live automation definitions, ledgers, CRM PDFs, production environment files, and historical ad hoc repair scripts. The guide explains the logic; actual execution still needs authorized private state.
