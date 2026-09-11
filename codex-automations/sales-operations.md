# Sales operations and outreach

[Catalog home](README.md) · [Coverage and limitations](workspace-coverage.md)

Supervised workflows using private state and authorized accounts.

<a id="so01"></a>

## SO01 — Approved initial email preparation and delivery

**Status:** Source present. **Purpose:** Turn verified account/contact research into controlled initial outreach.

**How it works:** Prepare exact recipient/copy worklists, enforce approval and suppression, and use the configured exact meeting CTA. Existing Outlook web in Chrome supplies the signature. Persist pending action before sending; independently verify one new Sent Item and then complete CRM logging.

**Infrastructure:** Private Outlook ledger; Python/JS state and render helpers; authenticated Chrome; read connectors.

**Evidence:** Private: Sales hub/OUTLOOK_CADENCE.md; Stanley/tools/approved_initial_batch_state.py and outlook_prepare_send_batch.py. Public overview: operations/README.md.

**Sharing:** Private source or artifacts; public description only.

<a id="so02"></a>

## SO02 — Outlook Outreach Cadence Manager

**Status:** Configured. **Purpose:** Follow up on eligible introductions without losing thread context or duplicating delivery.

**How it works:** A regular cadence has four follow-ups: the first after two business days, then one business day between steps. Due time is 09:00 Pacific with holiday adjustment. Open the exact source thread, Reply All, preserve quoted history and one automatic signature, and verify delivery.

**Infrastructure:** Weekday 09:00 and 17:00 Codex schedule; local ledger; Outlook web Chrome; independent readback.

**Evidence:** Saved automation definition; current policy and dated run receipts. Public: operations/README.md; operations/reference/tools/outlook_cadence_state_fast.py.

**Sharing:** Private source or artifacts; public description only.

<a id="so03"></a>

## SO03 — Reply-stop, out-of-office, and suppression reconciliation

**Status:** Source present. **Purpose:** Keep contact eligibility consistent with new mail evidence.

**How it works:** Bounded inbox/Sent audits reconcile exact message and contact identities. Replies pause the exact person; return dates adjust eligibility; bounces/unsubscribe/contact DNC stop that person. Explicit company DNC applies across verified company contacts. Preserve historical state.

**Infrastructure:** Read connectors, audit cursors, Python/PowerShell ledger reconciliation.

**Evidence:** Private: outlook_pause_exact_contact.py; outlook_reconcile_exact_contact_stop.py; outlook_stop_company_domain.py; cadence policy.

**Sharing:** Private source or artifacts; public description only.

<a id="so04"></a>

## SO04 — Outlook editor rendering and uncertain-send recovery

**Status:** Source present. **Purpose:** Prevent malformed copy and duplicate sends during UI interruptions.

**How it works:** Validate rendered block order, exact copy, signatures, and quoted thread. Store pending action before the UI send. An accepted send with inconclusive verification stays pending for reconciliation and is never automatically resent. Dated repair helpers belong to this workflow.

**Infrastructure:** Python guards, JS browser runtime, stable step keys and Sent Item verification.

**Evidence:** Public: operations/reference/tools/outlook_initial_render_guard.py; operations/reference/tools/outlook_reply_render_guard.py. Private: outlook_draft_review_runtime.mjs; outlook_record_verified_send.py.

**Sharing:** Private source or artifacts; public description only.

<a id="so05"></a>

## SO05 — Monday Morning TAL Touch event invitations

**Status:** Configured. **Purpose:** Match eligible TAL executives to relevant events.

**How it works:** Read current event details and verify each eligible C-suite/controller/VP/president through current ZoomInfo evidence. No minimum company recipient count or event lead-time cutoff. Dedupe exact person/event, obtain batch approval, and send at most one same-run invitation per person with one optional webinar alternative.

**Infrastructure:** Monday 10:30 Codex schedule; MMTT state helpers; event research; Outlook/NetSuite Chrome.

**Evidence:** Saved automation definition; private MMTT_POLICY.md; public operations/README.md and operations/reference/tools/mmtt_state_fast.py. See scheduled-automations.md for prompt drift.

**Sharing:** Private source or artifacts; public description only.

<a id="so06"></a>

## SO06 — Event invitation follow-up and touch tracking

**Status:** Source present. **Purpose:** Follow up on approved event invitations under their own cadence.

**How it works:** Two follow-ups: three business days after initial, then two after the first follow-up, at 09:00 Pacific with holiday handling. Exact-event/person suppression, reply stops, delivery verification, and CRM touch gates remain binding.

**Infrastructure:** Shared Outlook delivery workflow, MMTT cadence/item/touch state helpers.

**Evidence:** Private: mmtt_cadence_update.py; mmtt_item_update.py; mmtt_touch_state_fast.py. Public: operations/README.md.

**Sharing:** Private source or artifacts; public description only.

<a id="so07"></a>

## SO07 — LinkedIn prospecting and connection provenance

**Status:** Configured. **Purpose:** Build an attributable prospecting network from eligible claimed accounts.

**How it works:** One coordinator owns the LinkedIn and browser locks. Current NetSuite eligibility excludes SQL, Meeting Scheduled, Rep Engaged, DNC, and substantive active conversations. At most nine lifetime automation requests and three per company per day. Persist the exact profile only after visible send confirmation.

**Infrastructure:** Daily 07:00 scheduler with weekday/time gates; Chrome; canonical profile/company ledger.

**Evidence:** Saved automation definition; LINKEDIN_CADENCE.md; public operations/reference/linkedin_followup_state_fast.py and lock scripts.

**Sharing:** Private source or artifacts; public description only.

<a id="so08"></a>

## SO08 — LinkedIn acceptance, backfill, and two-step cadence

**Status:** Source present. **Purpose:** Follow up only with profiles connected by this automation.

**How it works:** Require affirmative exact-profile request provenance, inspect the conversation before each message, and permanently stop on any reply. The request note is message zero. Provenance-qualified historical note-less requests can receive one backfill. Follow-ups use the current business-day timing and end after step two.

**Infrastructure:** Private LinkedIn ledger, exact-state readers, Chrome messaging, NetSuite touch queue.

**Evidence:** Public: operations/README.md. Private: update-linkedin-acceptance-state.ps1; provenance import/reconciliation helpers; current ledger.

**Sharing:** Private source or artifacts; public description only.

<a id="so09"></a>

## SO09 — NetSuite email activity completion and retry queue

**Status:** Source present. **Purpose:** Keep CRM activity aligned with each verified email.

**How it works:** Create one activity per recipient on the exact correct company with required subject and TAL Email type. Commit and recheck the dropdown, save, and verify readback. Unfinished logging gets one deduplicated retry; never resend mail to repair a touch. Historical rollup scripts are separate repair artifacts.

**Infrastructure:** NetSuite existing Chrome tab; Python state; JS touch runtime.

**Evidence:** Private: netsuite_email_touch_runtime.mjs; approved_tal_touch_state.py; netsuite_company_touch_state.py; dated receipts. Public: operations/README.md.

**Sharing:** Private source or artifacts; public description only.

<a id="so10"></a>

## SO10 — NetSuite LinkedIn and phone-call touch workflows

**Status:** Source present. **Purpose:** Record verified outreach or user-specified completed call activity.

**How it works:** LinkedIn follow-ups require exact subject and TAL LinkedIn Touch readback; completed connection blocks queue their defined activity. Phone-call tasks work from explicit activity facts. Deduplicate against existing activities and keep attempted versus saved counts separate.

**Infrastructure:** NetSuite Chrome; exact worklists, company touch state/runtime, receipts.

**Evidence:** Private: tools/netsuite_company_touch_runtime.mjs; netsuite_week_company_touch_state.py; Phone Call Touch Automation and TAL Drop Automation task records.

**Sharing:** Private source or artifacts; public description only.

<a id="so11"></a>

## SO11 — TAL gifting through Social Imprints

**Status:** Source present. **Purpose:** Research and send authorized business gifts, then log completion.

**How it works:** Verify employment, email, and business address using NetSuite, ZoomInfo, and official sources. Check past orders/touches, submit once per approved recipient, confirm the order, then save and verify the TAL Drop activity. Missing identity/address or gift availability blocks the exact item.

**Infrastructure:** Custom send-tal-drops skill; authenticated Chrome; gifting portal and CRM.

**Evidence:** Private installed custom skill: .codex/skills/send-tal-drops/SKILL.md; completed task receipts. No gift orders or recipient data published.

**Sharing:** Private source or artifacts; public description only.

<a id="so12"></a>

## SO12 — Sales Navigator customer CSV uploads

**Status:** Source present. **Purpose:** Upload numbered customer lists reliably across throttling and interruptions.

**How it works:** Verify CSV hashes/manifest and destination list, map company name and website, persist pending_finish, click Finish once, and read back processing/list identity. Reconcile uncertain completion before retry. Bounded cooldowns escalate to deferred retry; serial checkpoints prevent duplicate lists.

**Infrastructure:** Custom sales-nav-customer-csv-upload skill; upload_state.py; existing Chrome; local CSV manifest.

**Evidence:** Private custom skill and scripts/upload_state.py; Customers CSV and Resume Sales Nav CSV uploads tasks. The old scheduled continuation is deleted (HX01).

**Sharing:** Private source or artifacts; public description only.

<a id="so13"></a>

## SO13 — TAL health and disqualification audit

**Status:** Artifact present. **Purpose:** Separate genuine disqualification, nurture, and contradictory recent evidence.

**How it works:** Review account/communication evidence with company/domain scope and named-person attribution. Distinguish a real objection from generic unanswered outreach; newer substantive evidence can override an old conclusion. Produce recommendations and evidence, not automatic CRM changes.

**Infrastructure:** Python classifiers, read-only mailbox research, structured review outputs.

**Evidence:** Private: audit_tal_dq_candidates.py; tal_audit_classifier.py; TAL Health completed task and output package.

**Sharing:** Private source or artifacts; public description only.

<a id="so14"></a>

## SO14 — Lead qualification and claiming workflow

**Status:** Historical. **Purpose:** Research eligible companies and maintain exact CRM ownership/status decisions.

**How it works:** Verify company identity, current ownership, fit, communication, and duplicate status before authorized claim or note changes. Historical completed batches preserve CRM readback. This record of past work does not establish current eligibility or permission to repeat an old batch.

**Infrastructure:** NetSuite and research tools; claim queues and historical receipts.

**Evidence:** Private: Lead Claimer task; build_claim_queue.mjs; build_lsad_csv.mjs. Imported command-center utilities are listed separately in HX06.

**Sharing:** Private source or artifacts; public description only.

<a id="so15"></a>

## SO15 — Contact research and outreach worklist preparation

**Status:** Source present. **Purpose:** Build individually verified contacts and connect them to exact accounts.

**How it works:** Combine current role, work email, location, and account context; distinguish observed evidence from guesses. Crosswalk approved contacts to lead identity and keep provenance, suppression, and approval in the worklist. Email enrichment artifacts support research but do not independently prove eligibility.

**Infrastructure:** ZoomInfo and official-source research; local JSON/Markdown; dated JS worklist builders.

**Evidence:** Private: tal-contact-research and tal-prospeo-enrichment reports; build-tal-lead-context-crosswalk and build-tal-initial-final-worklist scripts.

**Sharing:** Private source or artifacts; public description only.
