# Customer comparisons

Explore Jev Intelligence → Find operating matches starts with Similar to recent customers. Nine focused operating-pattern views combine source-supported facts on both the customer and prospect. All characteristics retains the full 47-category library, existing traits and research combinations.

The entire maintained private customer registry is eligible; there is no customer-count ceiling or curated-sample restriction. Each customer is collected and classified, but appears in a pattern only when the required operating facts are supported. Dates and announcement types remain explicit: a renewal or expansion is not presented as a new customer sale. These are operating similarities, not conversion probabilities or confirmed financial pain.

The 47 definitions originated in the broader Ring Ring research, not the initial 17-customer comparison sample. The original research screened 4,211 Slack posts and retained 704 company-research entries, using a mixture of direct official-page reads, public excerpts and explicitly unresolved sources. That is not a claim that every customer received a full website read or all 47 native classifications. The later 17-company sample was the first completely classified reference set. Full-cohort processing expands those native readings across the maintained registry and preserves the exact completed/pending/held counts.

Registered records account for customer announcements, including repeat posts and unnamed customers; the record count is not necessarily a distinct-company count. The displayed cohort summaries describe only current completed native readings. They separate supported, explicitly unsupported, conflicting and unknown answers by recorded industry and announcement recency. These counts are customer characteristics, not win rates, causal purchase explanations or newly invented Jev categories.

Ring Ring announcements are authoritative for customer status. Do not verify that status again against a website or another source. Use an announcement's supplied company website directly for operations research. Missing names, ambiguous entities and inaccessible websites are source gaps; they do not mean the announced business is not a customer.

Customer reference sources shows the full accounting, searchable entries, completed readings, pending work and source gaps. Read all customer websites starts a finite foreground run. Keep the view open to continue through confirmed saved passes; Stop after this pass finishes the accepted pass and stops further requests. Opening the view and refreshing matches make no paid Jev calls. A disconnected or uncertain paid request is reconciled read-only before any continuation.

## Evidence and cost

- Official homepages, supplied official URLs and directly observed About/Services links provide actual extracted text. Research summaries and Slack deal narratives are never substituted for website content.
- Generic legal/footer links are not mistaken for service pages during automatic link discovery. Explicitly supplied legal/commercial URLs and already captured evidence remain retained.
- Every page retains its URL, complete extracted text, hash, capture time and fetch outcome. Unsupported or inaccessible sources remain explicit gaps rather than negatives. Redirects cannot silently change company identity.
- Customer evidence uses the same 47 questions, definitions and 35 industry guides as prospect evidence. Native Jev answers are retained without a second model judge. Existing captures, completed unchanged classifications and exact requests are reused. Oversized evidence uses lossless packing where possible.
- Customer-only requests can exceed the ordinary 48 KB transport guard, up to 192 KB with unchanged literal evidence and criteria. This is a transport allowance, not a token estimate: the provider still enforces its context limit. A rejected request retains its exact receipt and partial answers rather than silently shortening the evidence or blindly retrying.
- Identity merges require explicit provenance. A shared domain alone never merges customers; exact repeated announcements are idempotent. Unnamed or unresolved records remain accounted for until their identity can be established.
- Matching reads compact cached facts across the entire registry, then hydrates full native evidence only for the displayed page. It does not recrawl or reclassify customers for each search.

## Operation

Apply migration `0131_private_customer_reference_registry.sql` before deploying this version. The private registry is service-only; no customer roster, Slack provenance or private narratives belong in the public repository.

Authenticated app routes expose `/api/headhunter/intelligence/customer-references` (GET progress, POST `{}` for one bounded pass) and `/import` (POST up to 100 exact records). The existing dedicated agent credential exposes the identical operations at `/api/agent/customer-references` and `/import`. No credential or permission expansion is required. Import batches limit request size only; keyset reads cover the full registry without a total limit.

Imports reuse explicitly mapped existing reference IDs and never reset paid results. Source collection and native classification have separate exact-record leases and checkpoints. Confirmed progress includes request reuse, input/output tokens and unknown-usage receipts; token counts are not a provider invoice. No new scheduler, TAM grading work or outreach is introduced.

Source collection follows meaningful operating pages rather than every page on a website. Consequently, a completed 47-question reading can contain unknown answers and source gaps. Completion describes the supplied evidence review, not exhaustive knowledge of the business.
