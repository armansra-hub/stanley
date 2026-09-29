# Customer-first Jev activation contract

This is the completion and activation checklist for the new customer-derived
classification workflow. It describes work still required after the software
foundation. It is not evidence that all customer websites have been read, that a
new taxonomy is approved, or that the TAM has been classified against it.

## What the current release establishes

- Codex-authored customer profiles have source manifests, page-read coverage,
  exact quoted facts, explicit unknowns and source gaps. Full source bodies stay
  in the private local archive; compact proof belongs in the existing database.
- Customer research and native Jev answers retain distinct authorship. Neither
  an imported RingRing record nor an old partial Jev reading is a completed
  Codex customer profile.
- Draft category definitions can state universal or industry applicability,
  affirmative evidence, exclusions, examples and customer support. Draft storage
  does not activate prospect classification.
- Paid purpose controls retain useful Trigger and prospect classifiers while
  retiring paid customer rereads, generic question/ranking work and TAM grading.
  The existing paid pause remains authoritative.
- Historical native answers remain readable. Filter clicks and local customer
  matching do not cause paid provider calls.

## Finish the customer research before approving definitions

1. Reconcile the maintained customer registry with the agreed announcement
   cutoff. Preserve every announcement and record; Slack establishes customer
   status. Do not introduce a customer-qualification gate.
2. Inventory and read each identifiable company's accessible site thoroughly,
   including linked service/product pages, operating documents, industries,
   case studies, locations, about pages and subsidiary information. Continue
   large inventories across checkpoints instead of treating a page cap as
   completion. Reuse adequate exact saved captures and duplicate pages.
3. Record genuine access failures and use approved public-source fallbacks.
   Unread pages, unfinished discovery and unidentified websites stay visible.
   A concrete source gap is not an invented negative characteristic.
   When documented discovery ends with an unresolved website or identity, use
   the explicit `unresolved` status with the attempted methods, summary and
   source gaps. No pending or unread discovered pages may remain. This can have
   zero source reads and zero facts; it is counted separately from researched
   customers. `completedAt` closes that attempt, not a claim of completed research.
4. Summarize recurring traits by distinct customer and industry, showing the
   actual researched denominator. Repeated announcements must not inflate
   prevalence. Recency and shared combinations may help prioritize resemblance
   but do not establish win probability, financial pain or purchase intent.
5. Approve the final definitions only after every registry record is accounted
   for with completed research or explicit source gaps. Show what remains
   unknown. The existing 47 predicates are hypotheses and saved legacy results,
   not proof that the full cohort has already defined the right categories.
   Accounted-for unresolved records may remain in the cohort, but cannot support
   a category, observed example, frequency claim or prospect match.

## Required future runtime integration — not implemented by this document

Use the existing `intelligence_directed_research_jobs` company lease, canonical
TAM membership, source observations, native receipts and catalog result tables.
Do not add another scheduler, membership list, research queue or grading path.

The current runtime in `lib/intelligence/operatingCoverage.ts` binds work to
`OPERATING_CATALOG_VERSION` and `OPERATING_FACETS`. Its database contract currently
requires 47 answers and `rr_*` facet IDs. A new dictionary stored in the customer
research tables cannot automatically run through that fixed contract.

The smallest future integration consists of:

1. **Explicit approved dictionary selection.** Add a nullable approved-version
   pointer, initially unset. Resolve its immutable dictionary and complete cohort
   proof before admission. Merely saving a draft or naming a version must never
   enable it. Keep the existing paid pause separate from dictionary selection.
2. **Injected catalog runtime.** Resolve either the preserved legacy catalog or
   the selected approved customer taxonomy into definitions, exact question
   builders, per-characteristic semantic versions and applicable guidance. Every
   lease carries the exact requested dictionary version; a changed pointer cannot
   silently alter an in-flight request.
3. **Parameterized database contract.** Replace the fixed 47-count and `rr_*`
   assumptions with membership in that exact registered dictionary. Validate the
   complete expected characteristic set before accepting a completed account.
   Update admission, snapshot, checkpoint, search and coverage reads together.
   Do not lower a count or reuse a label to make unfinished work look complete.
4. **Per-characteristic reuse.** Before requesting inference, compare the exact
   company/source evidence identity and each characteristic's semantic version
   against stored native results. Carry compatible answers forward with their
   unchanged raw results, citations and original receipts. Only missing or
   changed questions require paid work; obsolete answers remain historical data.
5. **Applicable question packs.** Supply universal characteristics plus the
   source-supported applicable industries. Mixed and uncertain business models
   remain explicit rather than silently omitted by a keyword shortcut. Include
   the complete predicate, required evidence, exclusions, examples and decision
   definitions in each relevant pack. Source packets must retain exact offsets
   and known coverage gaps; oversized evidence is checkpointed, not truncated
   into an unsupported answer.
6. **Reuse the existing paid lane.** Prospect classification remains
   `operating_catalog / account_catalog`; no extra customer-classification lane
   is needed. Purpose restrictions, the shared pause, one-use dispatch tickets,
   provider failure circuit and exact-request reuse continue to apply.

### What should and should not invalidate an answer

A changed predicate, exclusion, decision policy, applicable interpretation rule,
model contract, company identity or relevant evidence must invalidate the affected
answer. Do not carry a semantically different definition forward merely because
it has a familiar ID.

Display labels, growing customer support counts, reordered lists, capture clocks
and unrelated industry-guide edits should not alone invalidate an answer. The
current legacy `catalogFacetVersion` includes the complete shared industry
guidance. The future adapter must scope version inputs to the question's actual
semantic dependencies. Customer-definition versioning should likewise exclude a
pure display rename when that label is not part of the provider's rule.

Store the provider's original choice and payload. If the legacy database uses
`insufficient_evidence` where a new question says `unknown`, use an explicit
read/write normalization while retaining the exact native choice. Never invent
a probability or label Codex-authored customer research as a Jev answer.

## Activation and completion receipts

- Validate the approved dictionary against the complete accounted-for cohort;
  retain its immutable version and customer/source references.
- Install and read back any required schema changes through the established
  migration ledger. Confirm the existing pause is still off for paid dispatch.
- Verify an offline dry run showing counts of compatible reused answers,
  missing/changed questions, industry applicability and unresolved source gaps.
  No paid work is required for this accounting.
- Publish through GitHub `main` and Vercel's Git integration; verify the exact
  Ready deployment and commit. Never use a CLI production deployment.
- Obtain the agreed user review of the full cohort/category proposal before
  enabling paid prospect classification. Trigger classification remains an
  allowed capability, but a global paid pause also pauses those provider calls.
- After authorized activation, admit work through the existing queue. Report
  customer research completion, taxonomy approval and prospect classification
  completion separately, with exact denominators under the selected version.
- Routine operation processes new prospects or materially changed source/rule
  evidence. Opening a match, changing an industry filter or recalculating
  resemblance from stored facts remains free of Jev calls.

Database installation, application deployment, approved taxonomy selection,
paid activation, full customer research and full prospect coverage are distinct
states. Record each truthfully; none implies the others.
