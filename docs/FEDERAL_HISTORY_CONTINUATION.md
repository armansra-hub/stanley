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
existing separate page protocol. Records before 2007-10-01, separate IDV
collection, source omissions/updates and larger exact-company ID sets remain
coverage gaps. No live provider calls validated this implementation, and a
completed traversal is not an exhaustive federal-market coverage claim.

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
