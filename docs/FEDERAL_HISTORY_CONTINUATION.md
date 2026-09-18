# Federal history continuation boundaries

The recurring verified-entity subaward worker can split oversized searches into
adjacent inclusive date windows. The original cursor end date, verified entity
set, aliases and global persisted-ID set remain frozen. Windows cover exactly
`2007-10-01` through that original end date, without a gap or overlap. Each
window completes the existing stable-ID recheck before advancing. All windows
are searched again for each frozen alias/entity; IDs remain deduplicated across
those searches. Retry and dead-letter JSON retain the exact window checkpoint.

Splitting occurs at a **local work budget of 100 pages × 100 source results**,
or on the provider's explicit HTTP 422 maximum-result-window error. The local
10,000-result budget is not the provider's documented deployed ceiling. A full
budget-boundary page is partitioned even when `hasNext` says false; otherwise a
capped hit-count could silently hide the remainder. Legacy cursors beyond that
budget are replayed within smaller windows with their persisted IDs preserved.

A one-day window cannot be narrowed further. That condition stays partial with
an explicit reason distinguishing the local budget from a provider error. It
follows existing retry/dead-letter handling; it does not produce completed
metrics or a complete-history claim. The existing **25,000 persisted stable-ID
bound per subaward company continuation**, 16,384-window bound, three source
steps and 20 persisted rows per invocation remain. Large single-day histories,
larger exact-company ID sets, records before 2007-10-01 and provider omissions
remain coverage gaps. No production provider calls validated this implementation.

## Why this is limited to subawards

USAspending's [time-period implementation](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/search/filters/time_period/query_types.py)
maps both default subaward bounds to `sub_action_date`. Prime-award default
bounds instead compare the lower bound to latest `action_date` and the upper
bound to base `date_signed`. Reusing these date partitions for prime awards
would change which awards match and overlap long-lived awards. Prime history
and federal discovery therefore retain their existing semantics.

The [search endpoint contract](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/api_contracts/contracts/v2/search/spending_by_award.md)
offers paired `last_record_unique_id` and `last_record_sort_value` fields for
sequential search. Persisting and verifying that pair is the follow-up for prime
history/discovery and unsplittable subaward days. It is not implemented here.
The [public provider settings](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/settings.py)
were reviewed on 2026-09-18 and set award/subaward result windows to 50,000;
deployed configuration may differ. Only the
[endpoint's explicit limit error](https://github.com/fedspendingtransparency/usaspending-api/blob/master/usaspending_api/search/v2/views/spending_by_award.py)
triggers reactive partitioning; unrelated 422s, rate limits and network failures
retain their existing failure handling.

The isolated checkout tests cover legacy-cursor resume, inclusive boundary days,
global-ID deduplication, full boundary pages, provider errors, same-day overflow,
malformed/tampered partition scopes, and preservation through dead-lettering.
This does not activate a held production source or change release/lease gates.
