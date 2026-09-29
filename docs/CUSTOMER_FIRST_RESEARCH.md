# Customer-first research contract

`lib/intelligence/customerResearchProfiles.ts` separates authored customer research
from imported announcements, saved native Jev answers and prospect classification.
The module is deterministic and performs no network calls or paid evaluation.
It does not read or write TAM membership, grades or Old Gold.

Every RingRing-announced company is a customer for this project. Announcement IDs
preserve the provenance and repeated announcements. No NetSuite win verification
is required. Subsidiaries and corporate structure are business facts to understand,
not reasons to reject a customer.

## Research each company

1. Inventory the company website through navigation, sitemaps and discovered page
   links. Save discovery methods, exact URLs and dated outcomes. Read the accessible
   company pages, including services, products, industries, case studies, locations,
   ownership and subsidiaries. There is no fixed page limit or required 47-answer set.
2. Keep the full observed page text in a private local archive. Record both requested
   and resolved URLs, capture date, exact SHA-256 and actual reading date. A captured
   but unread page is unfinished work. `full_observed_text` means the complete text
   actually available in that capture; never label an excerpt or an unexpanded
   truncated page as a full capture.
3. Use LinkedIn and other public sources to resolve unavailable or unclear website
   information. Document remaining gaps. The website stays in the inventory even
   when it is unavailable. No site or external source needs to prove that the company
   is a customer again.
4. Author the business summary and open-ended facts. Identify each fact's subject:
   customer, subsidiary, parent, partner or another entity. A subsidiary's operating
   model must not silently become its parent's operating model. Record industry
   findings as evidence-backed `industry` facts, not guessed keywords.
5. Cite exact passages using source ID, source hash, UTF-16 start/end offsets and the
   exact quote. Preserve text and URLs without whitespace cleanup after offsets are
   calculated. The validator checks hashes, bounds and quote equality against the
   complete captured text. It does not run another model to judge the interpretation.

Facts have four distinct states:

- `supported`: the whole predicate is explicitly established for the named subject.
- `not_supported`: explicit evidence contradicts the predicate. Silence is insufficient.
- `unknown`: evidence is missing, partial or ambiguous; explanatory context is allowed.
- `conflicting`: attributable supporting and contradicting evidence remains unresolved.

Discovery has its own status. Each discovered page is pending, captured, unavailable
or excluded. Exclusions need a reason and are limited to duplicates, non-content
links, or material unrelated to the company. A duplicate must point to a captured
page. “Already have enough answers” is not an exclusion reason.

`normalizeCustomerResearchProfile(input)` validates and derives the research status:

- `draft`: research has not started, even if legacy Jev/native processing says ready.
- `in_progress`: discovery or reading is underway; no completed timestamp is claimed.
- `complete`: discovery has finished, every inventoried content page has a documented
  outcome, all captured pages were read, and summary/facts have been authored.
- `complete_with_gaps`: the same completed review, but inaccessible sources or other
  source gaps are explicitly recorded. This is never presented as complete source coverage.
- `unresolved`: a documented source or identity search has ended with a concrete gap.
  Requires attempted discovery methods, a summary, source gaps and no pending or unread
  pages. Zero read pages or facts are allowed. Its completed timestamp closes the attempt;
  this status is counted separately and never presented as researched customer evidence.

A homepage visit, a legacy `nativeAnswered: 47`, or a successful import cannot mark
research complete. The manifest cannot prove that an undiscovered page does not
exist; the research author must carry out and accurately record discovery.

## Compact cloud proofs, full local evidence

Call `projectCustomerResearchProfile(fullProfile)` only after local full-text
validation. Its `customer-research-proof-v1` result contains:

- Explicit Codex authorship and `codex_research` fact origin.
- Customer and announcement IDs, summary, coverage and source gaps.
- Source manifests: URL, resolved URL, title, capture/read dates, hash and character count.
- Page inventory and exact cited passages with decisions and subject attribution.
- A SHA-256 identity of the complete normalized local profile.

The projection omits full page bodies. Store that compact object in hosted storage;
keep the complete normalized profile and captures in the private local evidence
archive. List endpoints should read compact proofs rather than upload or return
all the collected websites. A compact proof is not re-admitted as if it were a full
source profile. New or revised proofs must pass validation against their full input.

Existing native Jev answers remain in their existing storage. The research schema
does not accept a fabricated `nativeResult`, probability or TAM score. Optional
legacy metadata records source/native status and saved result IDs solely for traceability.

Migration `0135_customer_research_profiles.sql` creates service-role-only research
profile storage and immutable taxonomy-version storage. It does not alter the
registry/native tables, source leases, matching answers or paid processing policy.
The authenticated agent bridge exposes:

| Method/path | Behavior |
| --- | --- |
| `GET /api/agent/customer-research?after=…&limit=25` | Keyset page of compact profiles and separate authored-research progress. |
| `GET /api/agent/customer-research?customerId=…` | Exact compact stored profile, or 404 when it has not been authored. |
| `POST /api/agent/customer-research` | Validate `{profile, expectedPreviousHash?}` against full source input, store only compact proof, and verify exact readback. |
| `GET /api/agent/customer-research/sources?customerId=…` | Read existing registry and checkpoint captures, unchanged, for local reuse. |

For later source pages, pass the returned `nextOffset` as `offset` and the exact
`registryUpdatedAt`. A changed registry stops that continuation instead of mixing
snapshots. Source exports are read-only, label missing/mismatched hashes explicitly,
and do not count a downloaded legacy capture as a new Codex reading.

Profile writes preserve the exact current registry name and announcement IDs;
the registry itself establishes customer membership. A registry row with no imported
announcement IDs uses an empty array, not an invented Slack message. Updates require
the previous stored profile hash. A mismatched readback is reported as uncertain;
the handler does not replay the write. Reads and saves never invoke a paid provider.

The full-input POST limit is 4 MB. Oversized profiles receive an explicit 413 and
remain in the local archive; nothing is silently truncated. A future chunked
admission path is needed for a single profile larger than that limit. Hosted list
reads contain compact proofs only. `loadCustomerResearchSummary` reports unavailable
when the migration or database is unavailable, rather than displaying fabricated zeros.

## Derive and version characteristics

`normalizeCustomerResearchTaxonomy(input, profiles)` validates a draft or approved
library for an explicit complete cohort. It is not limited to the legacy 47 traits.
Each characteristic contains:

- A stable ID and exact predicate.
- Universal applicability or explicit industry IDs.
- Required evidence rules and exclusions.
- Positive and negative examples, clearly illustrative or linked to observed facts.
- Exact customer/fact references supporting the characteristic.
- An automatically derived per-characteristic definition version.

Drafts can contain hypotheses while research proceeds. Approval requires every
cohort customer to have finished research or a documented unresolved attempt, and requires
each characteristic to have real customer support linked to the current definition
version. Illustrative examples cannot masquerade as observations. Facts about a
parent, partner or subsidiary cannot count as direct customer support without a
separately authored fact about the customer and its relationship. Unresolved customers
remain in the cohort denominator but cannot support categories, observed examples or matches.

`customerCharacteristicVersion(definition)` binds the actual predicate, applicability,
guidance, examples and decision policy. Growing the support list does not change the
version or invalidate already-paid compatible prospect answers. Display-only label
changes also leave the version and question body unchanged. A change to one
characteristic does not change every other characteristic's version.

`buildCustomerCharacteristicQuestion(definition)` returns a choice question with
the full predicate, exclusions, examples and four decision meanings. It makes no
provider call. The paid caller must separately enforce the approved-library and
paid-call policies. The question explicitly prohibits inferring financial pain,
purchase intent or a TAM grade. Customer examples explain the rule; they are never
evidence about a prospect.

`lib/intelligence/customerResearchComparison.ts` supplies the future pure read-side
adapter. `compareCustomerResearch` requires an approved library and accounted-for compact
proofs for its whole cohort, keeping unresolved records out of supported matches. It joins current-definition Codex customer facts with
the prospect's current-evidence-key native Jev choice answers. Customer citations
retain Codex authorship; prospect answers retain their original native result.
Source hash/range checks establish integrity without a second semantic classifier.
Stale definitions, changed evidence and missing answers remain unknown, and existing
native conflicts remain conflicting. A compatible legacy `insufficient_evidence` answer
displays as unknown while its native payload remains unchanged. The helper performs no writes or provider calls.

An industry selection includes universal characteristics and the named industry's
characteristics. Industry membership must come from explicit industry evidence;
an unknown industry is not guessed. With all industries selected, universal matches
can still appear when industry is unknown. This new adapter does not activate the
future workflow or replace the existing saved legacy view before the new research
and taxonomy are ready.

## Implementation boundary

These types, storage and authenticated endpoints establish the evidence/definition
contract. They do not claim the customer cohort has been read, schedule research,
purchase Jev credit, activate a classifier, or overwrite historical native results.
Actual completed research, UI presentation and deployment need their own concrete
receipts. Taxonomy storage has no automatic approval or activation endpoint.
