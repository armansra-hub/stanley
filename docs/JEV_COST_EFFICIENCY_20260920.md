# Jev research efficiency — September 20, 2026

The live ledger at 22:04 UTC attributed $32.414722 to public interpretation,
$0.268650 to private TAM and $0.117368 to research ranking. Another $14.818796
predated attribution and cannot honestly be assigned to a purpose. Federal
identity, event matching and saved questions had no attributed charges in this
snapshot. These are ledger estimates, not the vendor invoice.

The dominant work is website and news interpretation. Optimizing only federal
matching cannot substantially change its spending. The existing configuration
also has `spend_monitoring_only=true`: the $20 monthly setting reports spending
but does not stop work. This release preserves that setting and source cadence.

## Changes

- Fresh public requests use business-services-v4. The exact common grounding
  instructions appear once in `state.evaluationPolicy`; every question refers
  to them. All question-specific instructions, options, evidence, sections,
  identity context, source dates and model are retained. Collection timestamps
  remain in storage/receipts rather than changing the paid request identity.
- Started or partially paid v3 work finishes under its original contract and
  exact cache identity. There is no prompt-version backfill.
- Page dates follow the retained article/main boundary. Related article cards,
  widgets and unrelated script objects cannot make an unchanged article appear
  newly changed. Original HTML still feeds link discovery. Real source date,
  source text and identity changes remain eligible for new interpretation.
- Directed research reuses complete native answers only if every retained
  packet already answers every requested operating criterion under v3/v4, with
  matching evidence, source kind, date and identity context. New discovery
  provenance is stored. Missing questions and incomplete work still run.
- Website and deep-research publication-date conventions now agree. Already
  leased pages are excluded before paid ranking; the same ranking option/topic
  set has stable ordering without removing candidates or changing tie priority.
- Unchanged source sightings no longer requeue saved account questions. A
  changing job-start timestamp no longer defeats their exact answer reuse.
- The cost panel defaults to the last hour, with 24-hour and month history
  available. Its independent authenticated read can remain available when an
  unrelated intelligence feed read fails. The agent usage endpoint is also
  read-only and cannot dispatch work or invoke Jev.

## Evidence and limits

Exact adapter measurements with 24 questions reduced serialized request bytes
from 24,987 to 21,365 for 1,200 source characters (14.50%), and from 30,387 to
26,765 for 6,000 source characters (11.92%). These are payload measurements,
not measured invoice reductions or proof of identical model probabilities.

The live Vrana article had five captures with the same body and publication
date but different related-post timestamps. Replacing all three sidebar dates
in the actual public HTML now leaves its 602-character evidence, true October
23, 2015 publication date and all 57 discovered links unchanged.

The last-24-hour diagnostic found 2,536 additional same-body versions across
2,488 groups. Only three groups differed by requested research topics. Not
every version was proved wasteful, so these counts are not a savings estimate.

Historical costs do not decrease after a deployment. Fresh work uses the new
contract, while old paid continuations finish unchanged. New unique evidence
still costs money. No model downgrade, reduced polling, larger lossy packets,
evidence clipping, semantic second judge, TAM job, or new scheduler is added.
The canceled CRM evidence refresh remains canceled.
