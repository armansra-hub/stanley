# Business-services account research

Updated September 19, 2026. This is the collection and interpretation design, not a claim that every account is already covered or that public complexity proves buying intent.

The canonical territory remains `config/territory.ts`: agencies/media/publishing, business services, consulting and transportation/logistics, with its exact subindustries and exclusions. The research layer does not change membership, geographic eligibility, TAM grades or Old Gold. Geography guides relevant source selection under the existing territory rules; it does not add a new state gate to existing accounts.

## What the research looks for

| Account type | First useful operating clues | Deeper questions and changes |
| --- | --- | --- |
| Advertising/creative agencies | Projects, retainers, media buying, production and freelancers | Campaign/client margins, pass-through costs, vendor commitments, scope changes, utilization, unbilled work and agency-of-record wins |
| Media/publishing/music/broadcasting | Subscriptions, advertising, owned licensing and production | Rights/royalty workflows, contributor costs, deferred revenue, insertion orders and finance handoffs |
| Management consulting | Client project delivery and practice structure | Engagement margins, billable utilization, WIP/unbilled time, fee rules, reimbursables, subcontractors and PSA-to-finance work |
| HR/staffing/executive search | Contract placements, retained search and workforce delivery | Pay versus bill rates, time approval, placement margins, payroll/collections timing, VMS deductions and ATS/payroll/finance handoffs |
| Facilities/commercial cleaning | Recurring contracts, site service and one-off work orders | Site/contract margin, mobilization, labor capture, supplies/subcontractors, customer invoice requirements and branch reporting |
| Law/legal services | Matters, practices and firm offices | Unbilled time/disbursements, collections, matter/partner/practice economics and case-management integration; distinguish client funds from firm cash |
| Translation/linguistic services | Localization projects, interpretation and linguist networks | Project/language margins, freelance costs, per-word/hour/project fees, revisions and currency/system handoffs |
| Information/document management | Storage/retention, scanning, retrieval and destruction services | Recurring plus usage/project billing, customer/site margins, outside processing and operations-to-finance handoffs |
| Transportation/freight/rental/moving | Fleets, routes, branches and contracted operators | Customer/route economics, fuel/accessorials, carrier settlements, maintenance/assets/leases and TMS/dispatch-to-finance handoffs |
| All included services | Finance leadership and stated finance initiatives | ERP selection/implementation, close/reporting, reconciliations, controls, working capital, investor reporting, carve-out deadlines and acquisition integration |

Government work remains relevant when the prospect is an eligible private service provider. Public documents can reveal delivery and contract-accounting context. The existing exact-recipient federal award pipeline remains authoritative for award attachment; registration, contract ceiling, obligation, option and related-company activity retain their separate meanings.

These are research questions. A customer's project, vacancy, acquisition or building must not become the service provider's own event. Project delivery is deliberately broader than project billing complexity, so an ordinary services page can establish a useful operating model without revealing internal accounting terminology.

## How collection and Jev work together

Research recognizes both the public-discovery taxonomy and the current NetSuite TAM labels: Agencies, Management Consulting, Operational Support Services, Advisory Services, Freight & Logistics, Media & Publishing, Facilities Management and Passenger Transportation. Broad support/advisory labels prompt Jev to identify the actual service model from the source before using a specialized workflow. Account labels and TAM membership are unchanged.

1. The frequent collector reserves eligible TAM accounts lacking captured evidence first. A baseline reads the homepage and one discovered operating page. It immediately saves each usable source; optional-page failures do not erase that evidence.
2. A separate five-minute research schedule works through discovered but unread pages as well as due refreshes. It can follow new relevant company links. Its per-URL leases and revisit dates are shared with manual research.
3. Jev receives the named account, domain, actual source context, source dates and the relevant business-services lens. Operating questions are bounded to ten per packet: three general operating clues plus source/subindustry priorities. Research ranking asks Jev which discovered source to read next; it does not ask Jev to rejudge its previous answer.
4. Public text identity excludes private CRM locators. Unchanged evidence and paid packet interpretations are reused. The existing application spend envelope is unchanged.
5. Every native packet result retains its own attribution, passage and publication receipt. A different representative packet cannot suppress its operating topic. Useful undated or evergreen results remain available in the account; eligible dated developments can enter Triggered.
6. Existing source cards receive Jev context without duplicating the event. No second-model review is introduced. Broad traits, changes and unverified pain hypotheses remain distinguishable.

Saved-response recovery retains one oldest-job slot; the other two claim slots prefer normal/fresh evidence over routing replays. This preserves recovery progress without putting all newly captured signals behind the backfill.

Google RSS can remain headline-only when a real publisher body cannot be fetched. Such evidence is labeled; an empty healthy feed differs from a transport error. Supported ATS scans, missing boards and unsupported systems also have distinct status.

Deeper research also discovers relevant same-company PDFs, including capability statements, service brochures and annual reports. Extraction is limited to 3 MB, 12 pages and 20,000 text characters by default; the evidence retains page markers and truncation details. Scanned documents with no readable text are labeled empty, and no publication date is invented. This work runs separately from the fast website baseline.

The baseline collector is configured for up to 96 TAM website reservations every five minutes, a scheduled ceiling of 1,152 attempts/hour before deadlines, failures, eligibility and deduplication. This is not measured successful-account throughput. Deeper work is bounded to eight accounts per invocation with up to three leased sources per account. Frequent scheduling does not make every external source real-time.

## In the interface

- Open **Account Intelligence** inside a lead record. Back returns to the original lead; filters, notes and scroll stay mounted. Similar-account exploration also stays in this frame.
- **Operating Matches** supports **Any** or **All** selected topics and shows distinct account counts. Empty categories mean no supported evidence yet, not that no matching companies exist.
- Expand source evidence to inspect Jev's original answers and the supporting passage. Account research exposes findings even when they are not eligible as fresh triggers.
- Global diagnostics distinguish TAM coverage from source checks, queued depth from source errors, newest capture-hour processing from the rolling day, and all trigger cards from cards carrying Jev output.

## Research basis and product boundaries

The research priorities are an implementation inference from documented service workflows and financial capabilities, not measured prospect-conversion predictions.

- [NetSuite consulting and IT services](https://www.netsuite.com/portal/assets/public-pdf/ds-netsuite-for-consulting-and-it-services.pdf), [project costing](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/chapter_3748436271.html), [charge-based billing](https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_3752830510.html): project economics, resource and billing questions. SuiteProjects and SuiteProjects Pro are distinct offerings.
- [NetSuite advertising agencies](https://www.netsuite.com/portal/assets/pdf/ds-advertising.pdf) and [media/publishing](https://www.netsuite.com/portal/industries/media-publishing.shtml): agency and media revenue/cost workflows. Specialized ad-serving and rights tools can remain integrated.
- [RSM staffing solution](https://rsmus.com/technologies/netsuite/industries/business-professional-services/staffing-firms.html): first-hand partner description of placement margins and ATS/payroll integration. These are configured/integrated workflows, not a claim that base NetSuite replaces a staffing ATS or VMS.
- [RSM legal solution](https://rsmus.com/technologies/netsuite/industries/business-professional-services/law-firms.html): first-hand partner description of case/firm economics and Filevine integration. Do not promise legal trust compliance or partner economics without solution discovery.
- [NetSuite OneWorld](https://www.netsuite.com/portal/assets/pdf/ds-netsuite-oneworld.pdf), [financial close](https://www.netsuite.com/portal/products/erp/financial-management/finance-accounting/financial-close-management.shtml), [private equity](https://www.netsuite.com/portal/partners/private-equity-firms.shtml): consolidation, reporting and finance-change relevance.
- [USAspending data guide](https://www.usaspending.gov/data/Federal-Spending-Guide.pdf): award evidence distinctions. No automatic government accounting/compliance certification is implied.

Facilities, language and document-service priorities apply these documented project/recurring-billing and financial principles to their described service models. They are not represented as separate native NetSuite vertical products. Transportation research focuses on financial integration and service economics, not retail/manufacturing workflows or an automatic TMS replacement.
