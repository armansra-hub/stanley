# Federal history continuation boundaries

Prime history, federal discovery and subaward history now persist USAspending's
paired sequential cursor. `searchAfter` stores the provider's exact numeric
unique ID and opaque string sort value. It is never reconstructed from a
displayed award ID or date. The containing continuation preserves the query,
date scope and verified identity. A missing field means legacy offset mode;
`null` means sequential traversal restarted at page one; an object is the
anchor for the next request. Version-1 cursors remain readable.

The next anchor becomes durable only after every eligible record on the current
page completes its writes. Prime awards retain their current page anchor while
transaction work is pending, and also if final metric calculation fails. Stable
rechecks, alias/entity transitions and date-window transitions reset the anchor.
Discovery preserves the candidate across sequential pages and legacy restarts,
so a second conflicting recipient still causes an identity hold.

Legacy prime/discovery offsets at or beyond the local 100-page budget, or an
explicit provider result-window error, restart the **same frozen query** from
page one in sequential mode. Seen/ignored IDs and discovery candidates survive.
Once sequential mode is adopted, a missing, malformed, unsafe-integer, partial
or repeated next pair keeps the work partial; it never falls back to an offset
that could skip a page. Final `null` / `"None"` provider metadata is supported.

The recurring verified-entity subaward worker can split oversized searches into
adjacent inclusive date windows. The original cursor end date, verified entity
set, aliases and global persisted-ID set remain frozen. Windows cover exactly
`2007-10-01` through that original end date, without a gap or overlap. Each
window completes the existing stable-ID recheck before advancing. All windows
are searched again for each frozen alias/entity; IDs remain deduplicated across
those searches. Retry and dead-letter JSON retain the exact window checkpoint.

For legacy subaward pages without a sequential pair, splitting occurs at a
**local work budget of 100 pages × 100 source results**, or on the provider's
explicit HTTP 422 maximum-result-window error. The local
10,000-result budget is not the provider's documented deployed ceiling. A full
budget-boundary page is partitioned even when `hasNext` says false; otherwise a
capped hit-count could silently hide the remainder. Legacy cursors beyond that
budget are replayed within smaller windows with their persisted IDs preserved.

A one-day window cannot be narrowed further, so it now restarts its exact
single-day scope using sequential pagination. A valid provider pair can carry
it beyond the offset limit. If that pair is unavailable or invalid, the exact
checkpoint stays partial and follows existing retry/dead-letter handling.

Remaining local bounds: **25,000 completed award IDs per company continuation**,
25,000 ignored IDs per prime target, 25,000 transaction IDs per award,
**25,000 persisted subaward IDs per company continuation**, 16,384 subaward date
windows, and 10,000 discovery pages per target. Subaward invocations still have
three source steps and 20 persisted rows. Transaction traversal remains its
existing separate page protocol. Records before 2007-10-01, source omissions
and larger exact-company ID sets remain coverage gaps. A completed traversal
is not an exhaustive federal-market coverage claim.

## Contract vehicles and lifecycle

The prime continuation now finishes its frozen contract queries, resets the
provider anchor, and traverses the separate IDV collection for those same
recipients and aliases. Legacy continuations also enter this second phase.
`collection` survives retries and dead-letter storage. Completion requires both
phases and their transaction pages; a contract-only empty result cannot end the
search. First-recipient discovery also falls through to IDVs before no-match.

IDV requests use the documented IDV codes and `Last Date to Order` field. Its
exact value travels with the pending award through interrupted transaction work.
The source's signed date, performance dates, potential option end and ordering
date are separate. The API does not supply individual option-period schedules;
the UI says so instead of deriving them. Task/delivery orders retain the source
parent-vehicle link. Vehicle ceilings are excluded from contract-size metrics;
only the vehicle's own transactions contribute to obligation accounting. Related
entities remain outside all direct totals. The detail drawer displays the latest
50 stored direct contract actions, source-reported modification types and signed
obligation changes, including zero-dollar and deobligation actions.

On September 19, 2026 UTC, read-only live calls returned HTTP200 for the provider's
documented `CONT_IDV_FA304715A0037_9700` detail and an IDV search for UEI
`EBUHL3LJ3JE9`. The search returned `CONT_IDV_FA800322A0008_9700` with a
`2027-03-30` ordering end, another vehicle, and a valid sequential pair. Local
receipt: `work/federal-research/idv-live-reference.json`. This confirms the API
request shape; it is not a TAM enrollment or a production-history completion.

## SAM CAGE, legal-name and DBA discovery

The recurring SAM worker uses the public v4 API with exact UEI/CAGE queries for
existing verified identities, plus separate legal-name and DBA searches to find
additional legitimate recipients. Name matches still require source identity
evidence; CAGE/UEI bindings reject conflicting secondary identifiers. Public
registration is distinct from awarded work. No new paid source is required;
SAM's existing API key remains necessary.

One invocation reads one zero-based 10-row page. The exact query and current page
survive successful continuations, failures and dead letters through the existing
public-growth retry queue. A page advances only after its selected writes finish.
A full page receives a terminal follow-up read; provider URLs are never followed
with credentials. Repeated pages, changed bindings and the documented 10,000-row
API window become visible incomplete outcomes. Large-name queries at that source
limit require narrower source queries; they never report an exhaustive match.

Migration0064 adds one compact coverage row per company/source. Existing cron
owners write partial, complete, no-match, ambiguous or failed source receipts;
unattempted sources display as unsearched. The account drawer shows the scope,
dates and last attempt. Discovery completion means first-recipient discovery only;
source-history completion requires both prime/IDV and subaward histories. These
receipts do not release source holds or alter TAM grades.

The [SAM entity API contract](https://open.gsa.gov/api/entity-api/) documents
CAGE, UEI, legal-name/DBA filters, zero-based pages and the 10-record page size.
The [award-detail contract](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/awards/award_id.md)
documents IDV amounts and distinct performance/option dates. The source search
contract linked below documents the IDV code set and ordering-date field.

## Provider semantics

USAspending's [time-period implementation](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/search/filters/time_period/query_types.py)
maps both default subaward bounds to `sub_action_date`. Prime-award default
bounds instead compare the lower bound to latest `action_date` and the upper
bound to base `date_signed`. Reusing these date partitions for prime awards
would change which awards match and overlap long-lived awards. Prime history
and federal discovery therefore retain their existing semantics.

The [search endpoint contract](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/search/spending_by_award.md)
offers paired `last_record_unique_id` and `last_record_sort_value` fields for
sequential search. Its
[shared award/subaward implementation](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/search/v2/views/spending_by_award.py)
uses the pair as `search_after` and requests one lookahead result to determine
`hasNext`. Exact provider metadata is therefore used across all three readers.
The [public provider settings](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/settings.py)
were reviewed on 2026-09-18 and set award/subaward result windows to 50,000;
deployed configuration may differ. Only the
[endpoint's explicit limit error](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/search/v2/views/spending_by_award.py)
triggers reactive partitioning; unrelated 422s, rate limits and network failures
retain their existing failure handling.

The isolated checkout tests cover legacy-cursor resume, inclusive boundary days,
global-ID deduplication, full boundary pages, provider errors, same-day recovery,
missing/repeated pairs, interrupted page writes, metric failures, cross-page
identity ambiguity, malformed scopes and preservation through dead-lettering.
This does not activate a held production source or change release/lease gates.

## Regional and industry announcement coverage

Migration `0068_intelligence_regional_industry_sources.sql` extends the existing
RSS worker with seven free sources. The selection uses the current canonical TAM
concentration (California 2,266 accounts; Texas 1,462) and the concentration in
agencies, consulting, business services, logistics and media. It adds a
`coverage_description` to every registry source. These are announcement feeds;
they do not establish complete state/local procurement or award history.

| Source | Coverage | Requested poll interval |
| --- | --- | --- |
| [California GO-Biz](https://business.ca.gov/feed/) | Business investment, expansion, incentives, workforce and film/media projects | 60 minutes |
| [California Governor](https://www.gov.ca.gov/feed/) | Office announcements, including named-company investments and public projects | 15 minutes |
| [Texas Governor](https://gov.texas.gov/news/rss) | Office announcements, including enterprise expansion and economic-development projects | 15 minutes |
| [Texas Comptroller](https://public.govdelivery.com/topics/TXCOMPT_1/feed.rss) | Official English-language fiscal, business and agency releases through GovDelivery | 60 minutes |
| [FreightWaves](https://www.freightwaves.com/feed) | Published carrier, freight, logistics, facilities and supply-chain reporting | 15 minutes |
| [PR Newswire general business](https://www.prnewswire.com/rss/general-business-latest-news/general-business-latest-news-list.rss) | Company-authored expansion, leadership, workforce, outsourcing and service announcements | 15 minutes |
| [PR Newswire media](https://www.prnewswire.com/rss/entertainment-media-latest-news/entertainment-media-latest-news-list.rss) | Company-authored media, publishing, advertising and entertainment announcements | 15 minutes |

The official publisher pages advertise these endpoints. The Texas Comptroller
lists its feeds in its [RSS directory](https://comptroller.texas.gov/about/media-center/rss/);
PR Newswire lists its categories in its [RSS directory](https://www.prnewswire.com/rss/).
On September 19 UTC all seven endpoints returned valid RSS and representative
linked articles returned public HTML within the worker's size bounds. The local
receipts are `work/federal-research/feed-live-expansion.json`,
`feed-live-verification.json` and `regional-article-verification.json`.
Migration0060 +0064 +0068 passed an isolated PGlite application, including
reapplying0068 without changing a previously disabled source.

The worker fetches each linked article, matches current account names/domains,
and submits matching source text through the existing Jev queue. Overlapping
PR Newswire categories keep the same canonical article identity. Source claims
remain attributed to the publisher or company, and no second AI pass reviews
Jev's output. Poll intervals are requested source cadence; actual latency also
depends on source publication, the bounded shared-worker queue and cron capacity.
RSS windows are rolling snapshots, not durable publisher archives.

Port Houston's official feed was also inspected, but current item links are
PDFs that the HTML article worker cannot ingest. The American Staffing
Association candidate returned HTML rather than RSS. Neither endpoint is
enabled merely because its URL resembles a feed. Statewide CA/TX contract-award
ledgers remain outside these announcement sources; the registry descriptions
say so explicitly.
