# Jev research completion and ongoing discovery

An account is **caught up** when its eligible known sources have been read, no
source lease or retry remains, and its pending Jev interpretations have finished.
Unknown business facts remain unknown. This is a source-processing checkpoint,
not a claim that all public information has been found or every topic is present.

The existing account research queue stores that receipt as `complete`, with its
next discovery time. Existing crons can claim it when that time arrives. New
source links, changed source details, meaningful company identity/context edits
and newly eligible TAM accounts wake the same queue. Stable URL ordering,
pending-to-verified movement and rediscovery timestamps do not wake it.

Cheap discovery and ordinary website/news/contract checks keep their existing
cadence. Jev ranking runs only when there are due candidate sources. Capture
continues to use exact observation and request reuse; ordinary website/news
passes can also reuse completed deep-research answers if every retained packet
already answers their exact criteria with matching evidence, dates, source kind,
company context and model. Positive, negative and unknown native answers all
remain eligible for reuse. Unanswered questions and real changes still run.

New company context advances a server-owned revision only for that company.
Existing revision-zero observations are compatible without a backfill. Source
generations preserve changes arriving during a healthy URL lease; completing the
earlier read cannot postpone the new work for a week.

Collection reservations share capacity between uncovered accounts and ordinary
oldest-due monitoring. Interpretation claims share capacity among oldest work,
first account readings and fresh signals. Small batches use durable rotation so
no lane silently consumes every slot. Existing per-source backoff, leases,
failure handling and bounded workers remain authoritative.

The Intelligence page shows first readings separately from caught-up accounts,
pending evidence and hourly incoming/completed jobs. A source success may be an
empty result. The authenticated agent `intelligence/research-status` endpoint
exposes the same read-only aggregates independently of the main evidence feed.

This release does not change Jev's model, questions, source-text limits or native
answers, slow monitoring, apply a spending cap, or change TAM grading. It fixes
phantom discovery counts and redundant work; the remaining genuinely new work
still costs money. Savings must be measured after deployment and are not an
assumed percentage or a promised completion date.
