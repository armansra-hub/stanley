// Runtime operating definitions only. Customer names, win narratives and source links remain in the private local research corpus.
// O06 was explicitly excluded from the shipped catalog by the user.
export const OPERATING_FACET_DATA = [
  {
    "id": "rr_c01",
    "catalogId": "C01",
    "label": "Sells equipment plus installation and ongoing service",
    "definition": "The company supplies equipment and delivers installation plus continuing maintenance, monitoring or managed support.",
    "boundary": "A software company serving installers does not qualify; ordinary product support alone is insufficient.",
    "instructions": "Assess this fact about the target company's own business: The company supplies equipment and delivers installation plus continuing maintenance, monitoring or managed support. Boundary: A software company serving installers does not qualify; ordinary product support alone is insufficient.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "56a4cde56db37035a69e79ae4bc023e245c0dfc60bad8c266b99083bd459c063",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "IT / AV",
      "Security",
      "Industrial services",
      "Telecom"
    ],
    "discoveryHypothesis": "Coordinating product cost, project labor, service obligations and renewals is a plausible finance problem.",
    "legacyTopicOverlaps": [
      "inventory",
      "project_delivery",
      "recurring_revenue"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c02",
    "catalogId": "C02",
    "label": "Delivers projects plus ongoing managed services",
    "definition": "The same business offers discrete implementation/advisory projects and continuing managed operations or monitoring.",
    "boundary": "Retainer pricing or revenue percentages remain unknown unless stated.",
    "instructions": "Assess this fact about the target company's own business: The same business offers discrete implementation/advisory projects and continuing managed operations or monitoring. Boundary: Retainer pricing or revenue percentages remain unknown unless stated.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "8d48caef216514c33577c87754bd108d2b350f9c1d14f00d749faec58f260ac2",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Consulting",
      "IT",
      "Risk services"
    ],
    "discoveryHypothesis": "One customer can generate project and ongoing revenue with different delivery costs.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "recurring_revenue"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c03",
    "catalogId": "C03",
    "label": "Runs human-delivered services through its own platform",
    "definition": "A proprietary platform is paired with work actually performed or managed by the seller's people.",
    "boundary": "Selling software that helps customers perform services is a different model.",
    "instructions": "Assess this fact about the target company's own business: A proprietary platform is paired with work actually performed or managed by the seller's people. Boundary: Selling software that helps customers perform services is a different model.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "9de6783115cdb3d09b512afd098ca64d8aa55e0fba64894b3b28479f53803973",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Business services",
      "Software",
      "Outsourcing"
    ],
    "discoveryHypothesis": "Software, expert labor and service capacity may need a shared financial view.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "workforce_billing"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c04",
    "catalogId": "C04",
    "label": "Coordinates a network of outside providers",
    "definition": "The seller recruits, screens, dispatches or manages third-party providers to deliver customer work.",
    "boundary": "Do not assume all providers are contractors, or infer payment terms or gross/net accounting.",
    "instructions": "Assess this fact about the target company's own business: The seller recruits, screens, dispatches or manages third-party providers to deliver customer work. Boundary: Do not assume all providers are contractors, or infer payment terms or gross/net accounting.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "128d413a689be570eec88d999476a33a2d777e5c22ad16f5378be42e9a939bfb",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Facilities",
      "Logistics",
      "Staffing",
      "Language services"
    ],
    "discoveryHypothesis": "Customer charges, provider costs and job completion may need reconciliation.",
    "legacyTopicOverlaps": [
      "subcontractor_costs",
      "workforce_billing"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c05",
    "catalogId": "C05",
    "label": "Delivers services across many customer sites",
    "definition": "The company explicitly services a customer's portfolio of locations or executes regional/national rollouts.",
    "boundary": "Having several own offices or a national sales territory is not this trait.",
    "instructions": "Assess this fact about the target company's own business: The company explicitly services a customer's portfolio of locations or executes regional/national rollouts. Boundary: Having several own offices or a national sales territory is not this trait.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "9fdfc7842a85652c3be11d27d34209a376737ed35a0488c459172f84087244ac",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Facilities",
      "IT",
      "Security",
      "Field services"
    ],
    "discoveryHypothesis": "Site-level costs, SLAs and customer-level billing can differ from branch reporting.",
    "legacyTopicOverlaps": [
      "multi_location",
      "project_delivery"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c06",
    "catalogId": "C06",
    "label": "Runs multiple brands with shared business services",
    "definition": "Named operating brands/practices share management or administrative support under an operating group.",
    "boundary": "Brands, offices and legal entities are separate facts; PE backing alone does not establish this model.",
    "instructions": "Assess this fact about the target company's own business: Named operating brands/practices share management or administrative support under an operating group. Boundary: Brands, offices and legal entities are separate facts; PE backing alone does not establish this model.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "671600da80fcb7b5d1af301b93c73040c241da11eb805687e5fa987ef27f5e34",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Healthcare",
      "IT",
      "Agencies",
      "Holding companies"
    ],
    "discoveryHypothesis": "Local autonomy and group reporting can create a useful finance conversation.",
    "legacyTopicOverlaps": [
      "multi_entity",
      "acquisition_integration"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c07",
    "catalogId": "C07",
    "label": "Custom merchandise plus ecommerce or fulfillment",
    "definition": "The company designs, sources or produces customized physical merchandise and provides client ecommerce stores or warehousing/fulfillment services.",
    "boundary": "Customized physical merchandise and the target's ecommerce or fulfillment service must both be evidenced. General ecommerce fulfillment alone is a different model.",
    "instructions": "Assess this fact about the target company's own business: The company designs, sources or produces customized physical merchandise and provides client ecommerce stores or warehousing/fulfillment services. Boundary: Customized physical merchandise and the target's ecommerce or fulfillment service must both be evidenced. General ecommerce fulfillment alone is a different model.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "377dd9b055d396548e86a502dd098eec3ffe8da0132828e8e2800ce69a6b1309",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Promotional products",
      "Print",
      "Marketing services"
    ],
    "discoveryHypothesis": "Creative work, product costs and program logistics may need customer-level profitability.",
    "legacyTopicOverlaps": [
      "inventory",
      "project_delivery"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c08",
    "catalogId": "C08",
    "label": "Rents or manages equipment and services it",
    "definition": "Rental or managed assets are combined with delivery, setup, maintenance or operation.",
    "boundary": "Customer-owned assets, managed assets and owned rental fleets must be distinguished.",
    "instructions": "Assess this fact about the target company's own business: Rental or managed assets are combined with delivery, setup, maintenance or operation. Boundary: Customer-owned assets, managed assets and owned rental fleets must be distinguished.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "5d6063fd1f50e2c5d47ee5cf6578f46ae6a7b0d5173c3b3e45732fb3247f9b04",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Events",
      "Equipment services",
      "Transportation"
    ],
    "discoveryHypothesis": "Asset utilization, recurring charges and field/service costs may need coordination.",
    "legacyTopicOverlaps": [
      "fleet_costs",
      "inventory",
      "recurring_revenue"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c09",
    "catalogId": "C09",
    "label": "Charges by usage, transactions or variable units",
    "definition": "Pricing/terms explicitly identify consumption units, credits, transactions, active devices or similar variable charges.",
    "boundary": "AI or SaaS branding is not proof. Capacity-based annual licensing is a related but separate subtype.",
    "instructions": "Assess this fact about the target company's own business: Pricing/terms explicitly identify consumption units, credits, transactions, active devices or similar variable charges. Boundary: AI or SaaS branding is not proof. Capacity-based annual licensing is a related but separate subtype.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "c9c9db44bb1fe545d9913ba6a546174e0bd8735e137079baf4417fc8a0c4a41a",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "AI",
      "Telecom",
      "Software",
      "Platform services"
    ],
    "discoveryHypothesis": "Usage data, commitments and invoices may need to connect with finance.",
    "legacyTopicOverlaps": [
      "recurring_revenue"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c10",
    "catalogId": "C10",
    "label": "Sells through resellers, white labels or another brand",
    "definition": "An explicit reseller, wholesale, white-label or B2B2C distribution model exists.",
    "boundary": "Technology integrations and generic partner logos do not establish resale.",
    "instructions": "Assess this fact about the target company's own business: An explicit reseller, wholesale, white-label or B2B2C distribution model exists. Boundary: Technology integrations and generic partner logos do not establish resale.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "9476e0147435be6ea6959bebc6a4aca6f098ed365d7841d039968c7a181321f1",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Software",
      "IT",
      "Telecom",
      "Business services"
    ],
    "discoveryHypothesis": "Partner entitlements, discounts, commissions and downstream billing may matter.",
    "legacyTopicOverlaps": [],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c11",
    "catalogId": "C11",
    "label": "Licenses data, content or intellectual property",
    "definition": "The seller commercially licenses research, datasets, content, software/IP components or rights.",
    "boundary": "Differentiate receiving license revenue from paying rights owners; do not infer a royalty obligation from content alone.",
    "instructions": "Assess this fact about the target company's own business: The seller commercially licenses research, datasets, content, software/IP components or rights. Boundary: Differentiate receiving license revenue from paying rights owners; do not infer a royalty obligation from content alone.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "e4c32f03e550d6a0afd19ce88429b0b12ed15dabf3fd92a32594d2142b700bb5",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Research",
      "Media",
      "Software",
      "Data providers"
    ],
    "discoveryHypothesis": "Contract terms, entitlements, royalties or multiple distribution channels may need financial coordination.",
    "legacyTopicOverlaps": [
      "media_rights",
      "recurring_revenue"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_c12",
    "catalogId": "C12",
    "label": "Provides testing, inspection or compliance services",
    "definition": "The company actually performs testing, inspection, certification support or compliance work for clients, with the exact discipline identified.",
    "boundary": "Certification of the seller or compliance software alone is not proof that it performs the work.",
    "instructions": "Assess this fact about the target company's own business: The company actually performs testing, inspection, certification support or compliance work for clients, with the exact discipline identified. Boundary: Certification of the seller or compliance software alone is not proof that it performs the work.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "f540f37e0f05d454c4cf93a402dbe1da5252937b6e55565a195665e9972bfc44",
    "positiveAnswer": "supported",
    "priority": "First wave",
    "industries": [
      "Laboratories",
      "Field services",
      "Cybersecurity",
      "Risk"
    ],
    "discoveryHypothesis": "Qualified labor, evidence delivery and repeat service schedules can create project and service complexity.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "government_work"
    ],
    "sourcePaths": "services, products, pricing, partners/provider terms, locations, about/brands",
    "publication": "no_event_from_facet_alone",
    "group": "Cross-industry operating models"
  },
  {
    "id": "rr_t01",
    "catalogId": "T01",
    "label": "Freight brokerage using outside carriers",
    "definition": "The company arranges freight through a carrier network; tag explicit non-asset status separately.",
    "boundary": "A carrier network alone cannot prove the company owns no assets.",
    "instructions": "Assess this fact about the target company's own business: The company arranges freight through a carrier network; tag explicit non-asset status separately. Boundary: A carrier network alone cannot prove the company owns no assets.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "a24cfea2ce100858353677d551961fe79ad0aa4b1e8aef84cf6a6ebe7d8f0e8c",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Transportation"
    ],
    "discoveryHypothesis": "Shipment-level customer revenue and carrier costs are a relevant discovery area.",
    "legacyTopicOverlaps": [
      "non_asset_based_3pl",
      "subcontractor_costs"
    ],
    "sourcePaths": "transport services, carrier/customer terms, fleet/about, capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Transportation"
  },
  {
    "id": "rr_t02",
    "catalogId": "T02",
    "label": "Combines a fleet with brokerage or forwarding",
    "definition": "Both operated vehicles and arranged third-party transportation/forwarding are evidenced.",
    "boundary": "Do not label this pure non-asset-based 3PL.",
    "instructions": "Assess this fact about the target company's own business: Both operated vehicles and arranged third-party transportation/forwarding are evidenced. Boundary: Do not label this pure non-asset-based 3PL.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "d061435e3da546ad87514dcd6b853e1f0179c8e8b68eef7757f83a852901a7a1",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Transportation"
    ],
    "discoveryHypothesis": "Owned-fleet economics and purchased transportation costs may be managed differently.",
    "legacyTopicOverlaps": [
      "fleet_costs",
      "non_asset_based_3pl"
    ],
    "sourcePaths": "transport services, carrier/customer terms, fleet/about, capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Transportation"
  },
  {
    "id": "rr_t03",
    "catalogId": "T03",
    "label": "Dedicated transportation programs for customers",
    "definition": "Dedicated routes, capacity, customer-embedded teams or outsourced private-fleet operations are offered.",
    "boundary": "One strongly researched example; do not call this a proven high-conversion segment.",
    "instructions": "Assess this fact about the target company's own business: Dedicated routes, capacity, customer-embedded teams or outsourced private-fleet operations are offered. Boundary: One strongly researched example; do not call this a proven high-conversion segment.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "35278840c88ab2819bf98a3d6611ec2560a67eebd2db35081fdcd25b0bf80b20",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Transportation"
    ],
    "discoveryHypothesis": "Customer/route commitments, driver costs and equipment economics suggest contract-level profitability.",
    "legacyTopicOverlaps": [
      "fleet_costs",
      "recurring_revenue"
    ],
    "sourcePaths": "transport services, carrier/customer terms, fleet/about, capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Transportation"
  },
  {
    "id": "rr_t04",
    "catalogId": "T04",
    "label": "Specialized freight requirements",
    "definition": "Explicit cold-chain, entertainment touring, expedited, cross-border or specialist vehicle transport capabilities.",
    "boundary": "Keep subtype values separate; transporting for a sector is not evidence of every specialist capability.",
    "instructions": "Assess this fact about the target company's own business: Explicit cold-chain, entertainment touring, expedited, cross-border or specialist vehicle transport capabilities. Boundary: Keep subtype values separate; transporting for a sector is not evidence of every specialist capability.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "bf7d88f9aed7a240bfa1d318add460eb1d5ac5ef7505b2d8bfa81bdb942db6a2",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Transportation"
    ],
    "discoveryHypothesis": "Special handling can add scheduling, equipment and cost dimensions to a shipment.",
    "legacyTopicOverlaps": [
      "fleet_costs"
    ],
    "sourcePaths": "transport services, carrier/customer terms, fleet/about, capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Transportation"
  },
  {
    "id": "rr_t05",
    "catalogId": "T05",
    "label": "Last-mile delivery through partner fleets",
    "definition": "A last-mile operator coordinates DSPs or delivery partners, routes and delivery confirmation.",
    "boundary": "A merchant offering delivery or software for delivery operators does not qualify.",
    "instructions": "Assess this fact about the target company's own business: A last-mile operator coordinates DSPs or delivery partners, routes and delivery confirmation. Boundary: A merchant offering delivery or software for delivery operators does not qualify.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "aa63c1f5e76e79541aeacabdd01efcf429aa22e24b798663c9e3e1d01365b16f",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Transportation"
    ],
    "discoveryHypothesis": "High-volume jobs and partner settlements may need to align.",
    "legacyTopicOverlaps": [
      "subcontractor_costs",
      "workforce_billing"
    ],
    "sourcePaths": "transport services, carrier/customer terms, fleet/about, capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Transportation"
  },
  {
    "id": "rr_f01",
    "catalogId": "F01",
    "label": "Routine services plus projects, upgrades or reactive work",
    "definition": "Preventive/routine services coexist with projects, upgrades or reactive work.",
    "boundary": "Do not infer the recurring-contract fee structure from a maintenance service menu.",
    "instructions": "Assess this fact about the target company's own business: Preventive/routine services coexist with projects, upgrades or reactive work. Boundary: Do not infer the recurring-contract fee structure from a maintenance service menu.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "5bcfad2604bea8371ceb57f08a0ad2605bba9284d268b4f2cd3d17d41ee84e19",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Facilities",
      "Landscaping",
      "Industrial field services"
    ],
    "discoveryHypothesis": "Planned contracts and variable work may have different billing and margin patterns.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "recurring_revenue"
    ],
    "sourcePaths": "service/maintenance catalog, closeout/customer portal description, project case studies",
    "publication": "no_event_from_facet_alone",
    "group": "Field and project services"
  },
  {
    "id": "rr_f02",
    "catalogId": "F02",
    "label": "Compliance documentation tied to completed field work",
    "definition": "Inspection reports, calibration records, compliance forms or customer-portal closeout are explicit deliverables.",
    "boundary": "Whether documentation delays payment remains a discovery hypothesis.",
    "instructions": "Assess this fact about the target company's own business: Inspection reports, calibration records, compliance forms or customer-portal closeout are explicit deliverables. Boundary: Whether documentation delays payment remains a discovery hypothesis.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "a5cbe60a2c792e0f24eda7b7d7c433ddb4e6fdb5991c09686a78f5a804a0fdf4",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Industrial services",
      "Safety",
      "Facilities"
    ],
    "discoveryHypothesis": "Work completion and accepted documentation may be separate operational milestones.",
    "legacyTopicOverlaps": [
      "project_delivery"
    ],
    "sourcePaths": "service/maintenance catalog, closeout/customer portal description, project case studies",
    "publication": "no_event_from_facet_alone",
    "group": "Field and project services"
  },
  {
    "id": "rr_f03",
    "catalogId": "F03",
    "label": "Project delivery with multiple cost types",
    "definition": "The target delivers projects involving at least two evidenced cost types among labor, equipment, materials and subcontractors. Retain the specific cost types established by the evidence.",
    "boundary": "Do not require all four cost types or infer an unmentioned one. Selling project software does not establish project delivery or these costs in the vendor's own business.",
    "instructions": "Assess this fact about the target company's own business: The target delivers projects involving at least two evidenced cost types among labor, equipment, materials and subcontractors. Retain the specific cost types established by the evidence. Boundary: Do not require all four cost types or infer an unmentioned one. Selling project software does not establish project delivery or these costs in the vendor's own business.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "15d54dea8480e4e0e593f78bd0074b408072651a6f48939a9f94a5f927550a2e",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Construction",
      "Rail",
      "Engineering",
      "Installers"
    ],
    "discoveryHypothesis": "Costs scattered across systems can obscure true job profitability.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "inventory",
      "subcontractor_costs",
      "workforce_billing"
    ],
    "sourcePaths": "service/maintenance catalog, closeout/customer portal description, project case studies",
    "publication": "no_event_from_facet_alone",
    "group": "Field and project services"
  },
  {
    "id": "rr_i01",
    "catalogId": "I01",
    "label": "IT VAR with managed services",
    "definition": "The company resells hardware/software and provides ongoing managed IT or security services.",
    "boundary": "A vendor badge is not sufficient proof of resale.",
    "instructions": "Assess this fact about the target company's own business: The company resells hardware/software and provides ongoing managed IT or security services. Boundary: A vendor badge is not sufficient proof of resale.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "17aafbe50a1bb0dadb88e68e9e29eea588d675978b2eaad875fed8fb3aaba343",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "IT services"
    ],
    "discoveryHypothesis": "Resale procurement, renewals and service labor may share customers but different economics.",
    "legacyTopicOverlaps": [
      "inventory",
      "recurring_revenue"
    ],
    "sourcePaths": "solutions, vendor practices, reseller terms, managed service catalog, infrastructure pages",
    "publication": "no_event_from_facet_alone",
    "group": "Technology delivery"
  },
  {
    "id": "rr_i02",
    "catalogId": "I02",
    "label": "Vendor-specific implementation practice with ongoing support",
    "definition": "Dedicated implementation expertise for platforms such as ServiceNow, SAP or Maximo plus lifecycle support.",
    "boundary": "Being a competitor's implementation partner is not proof it uses that platform for its own finance.",
    "instructions": "Assess this fact about the target company's own business: Dedicated implementation expertise for platforms such as ServiceNow, SAP or Maximo plus lifecycle support. Boundary: Being a competitor's implementation partner is not proof it uses that platform for its own finance.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "7d6db05bd19aa2f854cccf244290dd8d7ea25ef6e1f66557a95050a3caaf85d4",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "IT consulting"
    ],
    "discoveryHypothesis": "Project staffing and ongoing service work can require connected finance.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "recurring_revenue"
    ],
    "sourcePaths": "solutions, vendor practices, reseller terms, managed service catalog, infrastructure pages",
    "publication": "no_event_from_facet_alone",
    "group": "Technology delivery"
  },
  {
    "id": "rr_i03",
    "catalogId": "I03",
    "label": "Operates hosting infrastructure plus managed services",
    "definition": "The company actually operates physical data-center or hosting infrastructure and also provides managed cloud or IT services.",
    "boundary": "Actual operation of owned or leased infrastructure qualifies. Cloud resale alone does not. Preserve the distinction between operation, equipment ownership and property ownership; none automatically establishes the others.",
    "instructions": "Assess this fact about the target company's own business: The company actually operates physical data-center or hosting infrastructure and also provides managed cloud or IT services. Boundary: Actual operation of owned or leased infrastructure qualifies. Cloud resale alone does not. Preserve the distinction between operation, equipment ownership and property ownership; none automatically establishes the others.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "bdb1c32f1350413b9c6214ef9918859bb333f23662aa4b7255c0a0b7a357f88a",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Hosting",
      "MSPs",
      "Telecom"
    ],
    "discoveryHypothesis": "Infrastructure assets and service/customer profitability may both matter.",
    "legacyTopicOverlaps": [
      "inventory",
      "recurring_revenue"
    ],
    "sourcePaths": "solutions, vendor practices, reseller terms, managed service catalog, infrastructure pages",
    "publication": "no_event_from_facet_alone",
    "group": "Technology delivery"
  },
  {
    "id": "rr_i04",
    "catalogId": "I04",
    "label": "Government-focused equipment and technical service delivery",
    "definition": "The seller supplies equipment, engineering or maintenance to government; record prime/subcontract/vehicle distinctions.",
    "boundary": "Government customer logos, registrations and vehicle eligibility are not the same as attributed awards.",
    "instructions": "Assess this fact about the target company's own business: The seller supplies equipment, engineering or maintenance to government; record prime/subcontract/vehicle distinctions. Boundary: Government customer logos, registrations and vehicle eligibility are not the same as attributed awards.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "64f634352af636f6e456da7df6ad0d14c0f05916339d428c8f7de18c5ebe2f41",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "GovCon",
      "IT VAR",
      "Telecom"
    ],
    "discoveryHypothesis": "Project costs, product procurement and contract requirements can coexist.",
    "legacyTopicOverlaps": [
      "government_work",
      "project_delivery",
      "inventory"
    ],
    "sourcePaths": "solutions, vendor practices, reseller terms, managed service catalog, infrastructure pages",
    "publication": "no_event_from_facet_alone",
    "group": "Technology delivery"
  },
  {
    "id": "rr_p01",
    "catalogId": "P01",
    "label": "Specialist labor placed or scheduled for customer assignments",
    "definition": "Screened professionals are assigned to shifts, placements, events or scheduled client work.",
    "boundary": "Separate permanent placement, temporary staffing, EOR and subcontractor models.",
    "instructions": "Assess this fact about the target company's own business: Screened professionals are assigned to shifts, placements, events or scheduled client work. Boundary: Separate permanent placement, temporary staffing, EOR and subcontractor models.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "115b41725b0d9bb53559c13322a026fb9411be007a3a673453667a991b400ddf",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Staffing",
      "Healthcare staffing",
      "Language services",
      "Events"
    ],
    "discoveryHypothesis": "Assignment profitability, credentials, time and payroll/provider costs may need coordination.",
    "legacyTopicOverlaps": [
      "workforce_billing",
      "project_delivery"
    ],
    "sourcePaths": "service models, assignments/programs, memberships and pricing",
    "publication": "no_event_from_facet_alone",
    "group": "Workforce and expertise"
  },
  {
    "id": "rr_p02",
    "catalogId": "P02",
    "label": "Expert investigations, litigation or case-based services",
    "definition": "Cases or investigations involve expert work, field activity, analytics or reports.",
    "boundary": "Contingency billing applies only when explicitly documented for the target; do not assign it to every case-based service firm.",
    "instructions": "Assess this fact about the target company's own business: Cases or investigations involve expert work, field activity, analytics or reports. Boundary: Contingency billing applies only when explicitly documented for the target; do not assign it to every case-based service firm.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "4251beaa1a1961aa0197bdf25bb30731ad92ffca1bcf68980e54bdf75f27ac8a",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Legal",
      "Investigations",
      "Risk"
    ],
    "discoveryHypothesis": "Case-level costs and timing can be more informative than generic consulting headcount.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "project_billing"
    ],
    "sourcePaths": "service models, assignments/programs, memberships and pricing",
    "publication": "no_event_from_facet_alone",
    "group": "Workforce and expertise"
  },
  {
    "id": "rr_p03",
    "catalogId": "P03",
    "label": "Research memberships plus advisory or communities",
    "definition": "Recurring access to proprietary research/communities coexists with advisory or other services.",
    "boundary": "Free newsletters and an ordinary blog do not establish a paid membership.",
    "instructions": "Assess this fact about the target company's own business: Recurring access to proprietary research/communities coexists with advisory or other services. Boundary: Free newsletters and an ordinary blog do not establish a paid membership.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "f0fe144753c87f8608346ea9615454f4b51adb6ef8b525536b9b779f4c85b837",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Research",
      "Advisory"
    ],
    "discoveryHypothesis": "Content entitlements and delivered services may have different revenue patterns.",
    "legacyTopicOverlaps": [
      "recurring_revenue",
      "media_rights",
      "project_delivery"
    ],
    "sourcePaths": "service models, assignments/programs, memberships and pricing",
    "publication": "no_event_from_facet_alone",
    "group": "Workforce and expertise"
  },
  {
    "id": "rr_m01",
    "catalogId": "M01",
    "label": "Experiential campaigns with physical production or staffing",
    "definition": "The target executes physical brand experiences, event activations, physical production or on-site field staffing for campaigns or events.",
    "boundary": "Digital strategy, digital content production or software for event operators alone does not establish physical execution.",
    "instructions": "Assess this fact about the target company's own business: The target executes physical brand experiences, event activations, physical production or on-site field staffing for campaigns or events. Boundary: Digital strategy, digital content production or software for event operators alone does not establish physical execution.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "8c047cb3cc4604650ef6d036da94ab3018c2e2c2622fee238d498b1496f2021c",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Agencies",
      "Events"
    ],
    "discoveryHypothesis": "Third-party production, labor and client project budgets may need to reconcile.",
    "legacyTopicOverlaps": [
      "project_delivery",
      "subcontractor_costs"
    ],
    "sourcePaths": "production/distribution services, media kits, licensing and creator terms",
    "publication": "no_event_from_facet_alone",
    "group": "Media and physical production"
  },
  {
    "id": "rr_m02",
    "catalogId": "M02",
    "label": "Produces or distributes physical publications and media",
    "definition": "Physical books/media/printed goods are produced or distributed; capture digital streams separately.",
    "boundary": "A streaming publisher does not automatically have physical inventory.",
    "instructions": "Assess this fact about the target company's own business: Physical books/media/printed goods are produced or distributed; capture digital streams separately. Boundary: A streaming publisher does not automatically have physical inventory.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "404204e4c62180b12e0ed04d73977dbdd5fe7a33d071a32965dd37364ad6b017",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Publishing",
      "Print"
    ],
    "discoveryHypothesis": "Titles/SKUs, production and distribution can sit alongside rights economics.",
    "legacyTopicOverlaps": [
      "inventory",
      "media_rights"
    ],
    "sourcePaths": "production/distribution services, media kits, licensing and creator terms",
    "publication": "no_event_from_facet_alone",
    "group": "Media and physical production"
  },
  {
    "id": "rr_m03",
    "catalogId": "M03",
    "label": "Several media revenue channels",
    "definition": "Evidence shows a combination of advertising, subscriptions, production, syndication or licensing.",
    "boundary": "Nonprofit broadcasting can have different funding; do not assume advertising revenue without evidence.",
    "instructions": "Assess this fact about the target company's own business: Evidence shows a combination of advertising, subscriptions, production, syndication or licensing. Boundary: Nonprofit broadcasting can have different funding; do not assume advertising revenue without evidence.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "1d1682806eeb5e26d7c09b18a86a29bb7eb4f74f717575f2eebc0dd3573ccced",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Broadcasting",
      "Entertainment"
    ],
    "discoveryHypothesis": "Different customers and commercial terms may converge in one finance team.",
    "legacyTopicOverlaps": [
      "recurring_revenue",
      "media_rights"
    ],
    "sourcePaths": "production/distribution services, media kits, licensing and creator terms",
    "publication": "no_event_from_facet_alone",
    "group": "Media and physical production"
  },
  {
    "id": "rr_m04",
    "catalogId": "M04",
    "label": "Royalties or payouts to creators and rights owners",
    "definition": "Author/artist/creator payouts or royalty administration are explicitly described.",
    "boundary": "Content ownership alone is not proof of payout obligations.",
    "instructions": "Assess this fact about the target company's own business: Author/artist/creator payouts or royalty administration are explicitly described. Boundary: Content ownership alone is not proof of payout obligations.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "0200f5c283292ce1c3579ca1eda58cb05e07dc0c6b6e0a22773944b5b26f86b5",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Media",
      "Publishing",
      "Creator platforms"
    ],
    "discoveryHypothesis": "Revenue received and amounts owed downstream may require statement-level tracking.",
    "legacyTopicOverlaps": [
      "media_rights"
    ],
    "sourcePaths": "production/distribution services, media kits, licensing and creator terms",
    "publication": "no_event_from_facet_alone",
    "group": "Media and physical production"
  },
  {
    "id": "rr_h01",
    "catalogId": "H01",
    "label": "Operates a group of practices, pharmacies or care providers",
    "definition": "An operating organization explicitly owns or manages multiple care practices, pharmacies or provider businesses; retain the care subtype and stated relationship.",
    "boundary": "A location, directory listing, franchise or referral partner is not automatically a subsidiary or separately maintained set of books.",
    "instructions": "Assess this fact about the target company's own business: An operating organization explicitly owns or manages multiple care practices, pharmacies or provider businesses; retain the care subtype and stated relationship. Boundary: A location, directory listing, franchise or referral partner is not automatically a subsidiary or separately maintained set of books.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "0df3b315ed69a5c657f30b9dac137af27af4ec97a757b62b671b94239cecb650",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Healthcare",
      "Veterinary"
    ],
    "discoveryHypothesis": "Local operations and group financial reporting may need to align.",
    "legacyTopicOverlaps": [
      "multi_entity",
      "multi_location",
      "acquisition_integration"
    ],
    "sourcePaths": "organization/practice/brand pages, care services, products, clinical capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Healthcare and life sciences"
  },
  {
    "id": "rr_h02",
    "catalogId": "H02",
    "label": "Combines healthcare products with care delivery",
    "definition": "Medication, diagnostic products or devices coexist with infusion, testing or other services.",
    "boundary": "Biotech development without patient services is a separate model.",
    "instructions": "Assess this fact about the target company's own business: Medication, diagnostic products or devices coexist with infusion, testing or other services. Boundary: Biotech development without patient services is a separate model.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "faaded942e0d12e69c4cf9519e17eef06d50c19cb55d44d28a89d9ea12288648",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Healthcare",
      "Diagnostics"
    ],
    "discoveryHypothesis": "Product and clinical-service activity may have different costs and reporting needs.",
    "legacyTopicOverlaps": [
      "inventory",
      "project_delivery"
    ],
    "sourcePaths": "organization/practice/brand pages, care services, products, clinical capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Healthcare and life sciences"
  },
  {
    "id": "rr_h03",
    "catalogId": "H03",
    "label": "Contract research, testing or life-science support",
    "definition": "The company provides research/testing/project expertise to external life-science customers.",
    "boundary": "Developing one's own drug pipeline is not a CRO.",
    "instructions": "Assess this fact about the target company's own business: The company provides research/testing/project expertise to external life-science customers. Boundary: Developing one's own drug pipeline is not a CRO.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "da8bfc648efdfd7f4a24ce284f5d1c614eed0d9562ee2c1c2e45dc31b183f2d4",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Life sciences services"
    ],
    "discoveryHypothesis": "Specialist people, equipment and customer projects can make delivery economics complex.",
    "legacyTopicOverlaps": [
      "project_delivery"
    ],
    "sourcePaths": "organization/practice/brand pages, care services, products, clinical capabilities",
    "publication": "no_event_from_facet_alone",
    "group": "Healthcare and life sciences"
  },
  {
    "id": "rr_s01",
    "catalogId": "S01",
    "label": "Devices or hardware combined with software/connectivity",
    "definition": "The company supplies devices plus an ongoing platform or connectivity component.",
    "boundary": "A software vendor tracking customers' devices or assets does not thereby supply hardware itself. Do not transfer customer workflows to the seller.",
    "instructions": "Assess this fact about the target company's own business: The company supplies devices plus an ongoing platform or connectivity component. Boundary: A software vendor tracking customers' devices or assets does not thereby supply hardware itself. Do not transfer customer workflows to the seller.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "f1c78a2391231dded8dc1dfcc5efbd58f7bc20645d78830258a426819ecbf7e0",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Software",
      "IoT",
      "Telecom"
    ],
    "discoveryHypothesis": "Shipment, activation and service/renewal events may differ.",
    "legacyTopicOverlaps": [
      "inventory",
      "recurring_revenue"
    ],
    "sourcePaths": "product/platform pages, pricing, human-service descriptions, payout terms",
    "publication": "no_event_from_facet_alone",
    "group": "Platforms and devices"
  },
  {
    "id": "rr_s02",
    "catalogId": "S02",
    "label": "Expert or managed work behind an AI platform",
    "definition": "The target provides an AI-enabled platform or service offer and substantive human annotation, analysis, domain expertise or managed delivery as part of that offer.",
    "boundary": "Both the target's AI-enabled offer and the substantive human work it performs or manages must be explicit. AI marketing alone, a conventional analyst service without an AI offer, or generic onboarding/support alone is insufficient. A separate service fee need not be published.",
    "instructions": "Assess this fact about the target company's own business: The target provides an AI-enabled platform or service offer and substantive human annotation, analysis, domain expertise or managed delivery as part of that offer. Boundary: Both the target's AI-enabled offer and the substantive human work it performs or manages must be explicit. AI marketing alone, a conventional analyst service without an AI offer, or generic onboarding/support alone is insufficient. A separate service fee need not be published.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "4a470600cf290a632c928b1a4515851d94d213f91f2c766a861534f00e0e4699",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "AI",
      "Technology services"
    ],
    "discoveryHypothesis": "Labor capacity and software usage can coexist in the cost model.",
    "legacyTopicOverlaps": [
      "workforce_billing",
      "project_delivery"
    ],
    "sourcePaths": "product/platform pages, pricing, human-service descriptions, payout terms",
    "publication": "no_event_from_facet_alone",
    "group": "Platforms and devices"
  },
  {
    "id": "rr_s03",
    "catalogId": "S03",
    "label": "Customer billing paired with provider or affiliate payouts",
    "definition": "The target's platform or service operation explicitly bills or collects charges from customers and coordinates related payments to providers, vendors, creators or affiliates.",
    "boundary": "Both the customer-billing role and the related provider-payout role must be evidenced. Payout software alone, referral directories or an unrelated affiliate program do not establish both. Gross-versus-net treatment and custody of funds cannot be inferred.",
    "instructions": "Assess this fact about the target company's own business: The target's platform or service operation explicitly bills or collects charges from customers and coordinates related payments to providers, vendors, creators or affiliates. Boundary: Both the customer-billing role and the related provider-payout role must be evidenced. Payout software alone, referral directories or an unrelated affiliate program do not establish both. Gross-versus-net treatment and custody of funds cannot be inferred.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "45b2cd83d1b821b1f0723a52aca7eb461c6bbdbd3002c369347f758c5530fb8d",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Platforms",
      "Commerce",
      "Service networks"
    ],
    "discoveryHypothesis": "Transaction fees, payouts and customer billing may require reconciliation.",
    "legacyTopicOverlaps": [
      "subcontractor_costs",
      "cash_working_capital",
      "media_rights"
    ],
    "sourcePaths": "product/platform pages, pricing, human-service descriptions, payout terms",
    "publication": "no_event_from_facet_alone",
    "group": "Platforms and devices"
  },
  {
    "id": "rr_r01",
    "catalogId": "R01",
    "label": "Research development with dated milestones",
    "definition": "A research company has an evidenced development stage and dated financing, trials, partnerships or commercialization milestones.",
    "boundary": "Funding alone is not buying intent; stage and timing must be sourced.",
    "instructions": "Assess this fact about the target company's own business: A research company has an evidenced development stage and dated financing, trials, partnerships or commercialization milestones. Boundary: Funding alone is not buying intent; stage and timing must be sourced. An event or milestone qualifies only when its date and the target's own role are explicit. Preserve historical dates; do not infer present urgency from an old event or from collection time.",
    "kind": "dated",
    "definitionVersion": "2",
    "definitionHash": "bf7aef7f47c14d6aa22655fc7ac65c48fe86cbc0e261aa80c3cf4c13d2e057d8",
    "positiveAnswer": "supported",
    "priority": "Exploratory",
    "industries": [
      "Biotech",
      "Deep technology"
    ],
    "discoveryHypothesis": "Program spending, entities and reporting can matter before conventional commercial scale.",
    "legacyTopicOverlaps": [
      "investor_reporting",
      "financial_controls"
    ],
    "sourcePaths": "product channels, manufacturing partners, milestone press releases, pipeline",
    "publication": "no_event_from_facet_alone",
    "group": "Dated changes"
  },
  {
    "id": "rr_r02",
    "catalogId": "R02",
    "label": "Physical products sold through multiple channels",
    "definition": "The business sells tangible products through more than one of wholesale, ecommerce, dealers or direct retail.",
    "boundary": "International sales are not proof of international subsidiaries.",
    "instructions": "Assess this fact about the target company's own business: The business sells tangible products through more than one of wholesale, ecommerce, dealers or direct retail. Boundary: International sales are not proof of international subsidiaries.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "a1c583fb1bbf97f81e9ba56576e859278d4695e2166ee5b1717ace0596cf5629",
    "positiveAnswer": "supported",
    "priority": "Sector facet",
    "industries": [
      "Distribution",
      "Retail",
      "Promotional products"
    ],
    "discoveryHypothesis": "Inventory and orders can span channels with different terms.",
    "legacyTopicOverlaps": [
      "inventory"
    ],
    "sourcePaths": "product channels, manufacturing partners, milestone press releases, pipeline",
    "publication": "no_event_from_facet_alone",
    "group": "Products and commercialization"
  },
  {
    "id": "rr_r03",
    "catalogId": "R03",
    "label": "Own products with outside manufacturing or fulfillment partners",
    "definition": "Owned/branded products are supplied using explicitly described tolling, manufacturing or fulfillment partners.",
    "boundary": "Supplier locations are not automatically company-owned sites.",
    "instructions": "Assess this fact about the target company's own business: Owned/branded products are supplied using explicitly described tolling, manufacturing or fulfillment partners. Boundary: Supplier locations are not automatically company-owned sites.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "fa9e5b8641a1b3879864e3a958a837d658a426d6e87d7619397c3d980f0ce747",
    "positiveAnswer": "supported",
    "priority": "Exploratory",
    "industries": [
      "Products and services",
      "Promotional goods"
    ],
    "discoveryHypothesis": "Offsite stock, production and delivered cost can become useful research topics.",
    "legacyTopicOverlaps": [
      "inventory",
      "subcontractor_costs"
    ],
    "sourcePaths": "product channels, manufacturing partners, milestone press releases, pipeline",
    "publication": "no_event_from_facet_alone",
    "group": "Products and commercialization"
  },
  {
    "id": "rr_n01",
    "catalogId": "N01",
    "label": "Operates publicly funded or grant-supported programs",
    "definition": "Published funding or program materials identify public, philanthropic or grant support for the organization or an exact program.",
    "boundary": "A nonprofit label or research partnership alone does not prove grant revenue, restricted funds or grant-accounting complexity.",
    "instructions": "Assess this fact about the target company's own business: Published funding or program materials identify public, philanthropic or grant support for the organization or an exact program. Boundary: A nonprofit label or research partnership alone does not prove grant revenue, restricted funds or grant-accounting complexity.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "0b15a148ce4db1939edd267448747c8307066a7c99c1cfc767cf4355a6626da0",
    "positiveAnswer": "supported",
    "priority": "Exploratory",
    "industries": [
      "Nonprofits",
      "Research organizations"
    ],
    "discoveryHypothesis": "Fund/program reporting and restricted funding may matter, when restrictions are explicitly supported.",
    "legacyTopicOverlaps": [
      "government_work",
      "investor_reporting"
    ],
    "sourcePaths": "program/funding reports, affiliate/member services",
    "publication": "no_event_from_facet_alone",
    "group": "Members and funded programs"
  },
  {
    "id": "rr_n02",
    "catalogId": "N02",
    "label": "Shared services for member organizations or a company family",
    "definition": "A central organization explicitly delivers support to affiliated members/entities.",
    "boundary": "Association membership is not an ownership relationship.",
    "instructions": "Assess this fact about the target company's own business: A central organization explicitly delivers support to affiliated members/entities. Boundary: Association membership is not an ownership relationship.",
    "kind": "stable",
    "definitionVersion": "2",
    "definitionHash": "f5c74a84ff0c078f617a88ffb4820956b81cad626c58a74d5c969af534f2fa75",
    "positiveAnswer": "supported",
    "priority": "Exploratory",
    "industries": [
      "Associations",
      "Financial services",
      "Shared services"
    ],
    "discoveryHypothesis": "Central costs and separate organizational reporting may need allocation.",
    "legacyTopicOverlaps": [
      "multi_entity"
    ],
    "sourcePaths": "program/funding reports, affiliate/member services",
    "publication": "no_event_from_facet_alone",
    "group": "Members and funded programs"
  },
  {
    "id": "rr_o01",
    "catalogId": "O01",
    "label": "Documented acquisition or business combination",
    "definition": "A dated acquisition or combination identifies the target's role and the named participating operating businesses.",
    "boundary": "PE investment alone is not an acquisition. A transaction does not by itself establish an integration project or present urgency.",
    "instructions": "Assess this fact about the target company's own business: A dated acquisition or combination identifies the target's role and the named participating operating businesses. Boundary: PE investment alone is not an acquisition. A transaction does not by itself establish an integration project or present urgency. An event or milestone qualifies only when its date and the target's own role are explicit. Preserve historical dates; do not infer present urgency from an old event or from collection time.",
    "kind": "dated",
    "definitionVersion": "2",
    "definitionHash": "8bb64b40dc81eba05f17966620b6200fe4745441fdd3bf81f1482de2f7c2053d",
    "positiveAnswer": "supported",
    "priority": "Existing overlay",
    "industries": [
      "All industries"
    ],
    "discoveryHypothesis": "Useful timing context for a model-fit prospect.",
    "legacyTopicOverlaps": [
      "acquisition_integration",
      "multi_entity"
    ],
    "sourcePaths": "dated own announcements, explicit current systems disclosures, authorized CRM notes",
    "publication": "no_event_from_facet_alone",
    "group": "Dated changes"
  },
  {
    "id": "rr_o02",
    "catalogId": "O02",
    "label": "New standalone entity or carve-out",
    "definition": "A spin-out, carve-out or newly independent finance operation is documented.",
    "boundary": "A new product launch or office does not establish a carve-out.",
    "instructions": "Assess this fact about the target company's own business: A spin-out, carve-out or newly independent finance operation is documented. Boundary: A new product launch or office does not establish a carve-out. An event or milestone qualifies only when its date and the target's own role are explicit. Preserve historical dates; do not infer present urgency from an old event or from collection time.",
    "kind": "dated",
    "definitionVersion": "2",
    "definitionHash": "d52c2909db9fcc9411a473ffb91fa37cdc9f4dba59af7c43cc65cd591b50c002",
    "positiveAnswer": "supported",
    "priority": "Existing overlay",
    "industries": [
      "All industries"
    ],
    "discoveryHypothesis": "Standalone books and systems can create a concrete transition.",
    "legacyTopicOverlaps": [
      "multi_entity",
      "systems_project",
      "investor_reporting"
    ],
    "sourcePaths": "dated own announcements, explicit current systems disclosures, authorized CRM notes",
    "publication": "no_event_from_facet_alone",
    "group": "Dated changes"
  },
  {
    "id": "rr_o03",
    "catalogId": "O03",
    "label": "Known finance-system deadline or replacement",
    "definition": "An exact source states the company's system and an upgrade, sunset, contract or replacement event.",
    "boundary": "Vendor-wide sunset dates do not prove a prospect uses that vendor.",
    "instructions": "Assess this fact about the target company's own business: An exact source states the company's system and an upgrade, sunset, contract or replacement event. Boundary: Vendor-wide sunset dates do not prove a prospect uses that vendor. An event or milestone qualifies only when its date and the target's own role are explicit. Preserve historical dates; do not infer present urgency from an old event or from collection time.",
    "kind": "dated",
    "definitionVersion": "2",
    "definitionHash": "da970818ee326c335a370e80614a1d72bb71f0eebb3e0479c580ac95a86c6447",
    "positiveAnswer": "supported",
    "priority": "Existing overlay",
    "industries": [
      "All industries"
    ],
    "discoveryHypothesis": "Turns business-model fit into a possible timing opportunity.",
    "legacyTopicOverlaps": [
      "systems_project",
      "finance_leadership"
    ],
    "sourcePaths": "dated own announcements, explicit current systems disclosures, authorized CRM notes",
    "publication": "no_event_from_facet_alone",
    "group": "Dated changes"
  },
  {
    "id": "rr_o04",
    "catalogId": "O04",
    "label": "Keep specialized operations; modernize finance",
    "definition": "Company-specific evidence supports retaining a vertical operating platform while adding/replacing finance.",
    "boundary": "A vertical business model alone does not establish current system architecture.",
    "instructions": "Assess this fact about the target company's own business: Company-specific evidence supports retaining a vertical operating platform while adding/replacing finance. Boundary: A vertical business model alone does not establish current system architecture. Establish the named target's actual finance/operating-system architecture or change plan only from explicit public evidence. Multiple brands, acquisitions, scale, job titles and technology-detection clues alone are insufficient.",
    "kind": "systems_context",
    "definitionVersion": "2",
    "definitionHash": "fe59d71c7761f11e1a1f1c95f18083c2dddff05d49efb368a2c69e86cc6598eb",
    "positiveAnswer": "supported",
    "priority": "Research angle",
    "industries": [
      "All industries"
    ],
    "discoveryHypothesis": "A suitable account may buy without replacing its TMS, practice or operational software.",
    "legacyTopicOverlaps": [
      "systems_project"
    ],
    "sourcePaths": "dated own announcements, explicit current systems disclosures, authorized CRM notes",
    "publication": "no_event_from_facet_alone",
    "group": "Explicit systems context"
  },
  {
    "id": "rr_o05",
    "catalogId": "O05",
    "label": "Several finance systems or separate books",
    "definition": "The target explicitly operates at least two finance/accounting systems, at least two separately maintained sets of entity books, or multiple disconnected accounting instances.",
    "boundary": "One named finance platform, multiple modules of one integrated instance, or public multi-location status alone does not establish separate books or fragmented accounting.",
    "instructions": "Assess this fact about the target company's own business: The target explicitly operates at least two finance/accounting systems, at least two separately maintained sets of entity books, or multiple disconnected accounting instances. Boundary: One named finance platform, multiple modules of one integrated instance, or public multi-location status alone does not establish separate books or fragmented accounting. Establish the named target's actual finance/operating-system architecture or change plan only from explicit public evidence. Multiple brands, acquisitions, scale, job titles and technology-detection clues alone are insufficient.",
    "kind": "systems_context",
    "definitionVersion": "2",
    "definitionHash": "11016b23e7ec36fb33920e382b3c432b1f70d82ab996bc1246970a2d99f1efed",
    "positiveAnswer": "supported",
    "priority": "Existing overlay",
    "industries": [
      "All industries"
    ],
    "discoveryHypothesis": "Consolidation and reporting are sensible discovery hypotheses.",
    "legacyTopicOverlaps": [
      "multi_entity",
      "close_reporting"
    ],
    "sourcePaths": "dated own announcements, explicit current systems disclosures, authorized CRM notes",
    "publication": "no_event_from_facet_alone",
    "group": "Explicit systems context"
  }
] as const;

export const OPERATING_GUIDE_DATA = [
  {
    "id": "G01",
    "label": "Freight brokerage and forwarding",
    "guidance": "Carrier network, shipper verticals, cross-border/customs services, specialized freight, documented asset-light model",
    "boundary": "do not infer non-asset ownership from brokerage language alone",
    "primaryFacetIds": [
      "rr_t01",
      "rr_t04",
      "rr_c04",
      "rr_c09",
      "rr_s03",
      "rr_o04"
    ],
    "sourcePaths": [
      "services/freight",
      "carrier network",
      "cross-border/customs",
      "shipper industries",
      "about asset model"
    ],
    "currentLane": "TRANSPORT",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G02",
    "label": "Fleet and dedicated transportation",
    "guidance": "Dedicated customer programs, fleet plus brokerage, contractor drivers, specialized operating systems",
    "boundary": "dedicated programs are a narrow hypothesis, not a cohort-wide conclusion",
    "primaryFacetIds": [
      "rr_t02",
      "rr_t03",
      "rr_t04",
      "rr_c04",
      "rr_c08",
      "rr_s03",
      "rr_o04"
    ],
    "sourcePaths": [
      "fleet/equipment",
      "dedicated transportation",
      "brokerage",
      "driver/contractor programs"
    ],
    "currentLane": "TRANSPORT",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G03",
    "label": "Last-mile and local delivery",
    "guidance": "Partner fleets, sorting/depots, provider payout process, ecommerce delivery",
    "boundary": "distinguish delivery operator from software provider",
    "primaryFacetIds": [
      "rr_t05",
      "rr_c04",
      "rr_c05",
      "rr_c09",
      "rr_s03",
      "rr_o04"
    ],
    "sourcePaths": [
      "delivery network",
      "service areas/depots",
      "delivery partner terms",
      "ecommerce delivery services"
    ],
    "currentLane": "TRANSPORT",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G04",
    "label": "Warehousing, fulfillment and ecommerce operations",
    "guidance": "Storage, pick/pack, returns, client stores, merchant-of-record/product ownership",
    "boundary": "physical role matters",
    "primaryFacetIds": [
      "rr_c07",
      "rr_c04",
      "rr_c05",
      "rr_c09",
      "rr_s03",
      "rr_o04"
    ],
    "sourcePaths": [
      "warehousing/fulfillment",
      "returns",
      "client webstores",
      "terms/merchant of record",
      "facilities"
    ],
    "currentLane": "TRANSPORT or OPERATIONAL_SUPPORT",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G05",
    "label": "Cleaning, landscaping and facilities",
    "guidance": "Recurring site service plus projects/callouts, national accounts, subcontractor network",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_c05",
      "rr_f01",
      "rr_f02",
      "rr_f03",
      "rr_c04",
      "rr_c02",
      "rr_c06"
    ],
    "sourcePaths": [
      "maintenance services",
      "emergency/callout",
      "national accounts",
      "vendor/subcontractor network",
      "client-site case studies"
    ],
    "currentLane": "Facilities Management & Commercial Cleaning",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G06",
    "label": "Fire, safety and physical security",
    "guidance": "Installations plus inspection, monitoring, maintenance; acquisition platforms",
    "boundary": "A software vendor serving fire, safety or security operators does not thereby perform their field work.",
    "primaryFacetIds": [
      "rr_c01",
      "rr_f01",
      "rr_f02",
      "rr_f03",
      "rr_c05",
      "rr_c06",
      "rr_o01"
    ],
    "sourcePaths": [
      "equipment/system brands",
      "installation",
      "inspection/monitoring",
      "maintenance",
      "acquisitions"
    ],
    "currentLane": "OPERATIONAL_SUPPORT or GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G07",
    "label": "Industrial equipment and field service",
    "guidance": "Parts/equipment sales, scheduled repairs, documentation, emergency jobs",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_c01",
      "rr_c08",
      "rr_f01",
      "rr_f02",
      "rr_f03",
      "rr_c05"
    ],
    "sourcePaths": [
      "equipment/parts",
      "rental",
      "repair/field service",
      "inspection documentation",
      "emergency service"
    ],
    "currentLane": "OPERATIONAL_SUPPORT or GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G08",
    "label": "Civil, environmental and infrastructure services",
    "guidance": "Field crews, specialist equipment, compliance deliverables, project/subcontract costs",
    "boundary": "finance pain remains unverified on prospects",
    "primaryFacetIds": [
      "rr_f02",
      "rr_f03",
      "rr_c05",
      "rr_c08",
      "rr_c12",
      "rr_c04"
    ],
    "sourcePaths": [
      "project case studies",
      "field capabilities",
      "equipment",
      "compliance deliverables",
      "subcontractor programs"
    ],
    "currentLane": "OPERATIONAL_SUPPORT or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G09",
    "label": "Signage and fabrication",
    "guidance": "Design, fabrication, installation, maintenance across client sites",
    "boundary": "retain actual manufacturing versus outsourced production",
    "primaryFacetIds": [
      "rr_c01",
      "rr_f03",
      "rr_c05",
      "rr_r02",
      "rr_r03",
      "rr_f01"
    ],
    "sourcePaths": [
      "design/fabrication",
      "installation",
      "maintenance",
      "production facilities",
      "national account programs"
    ],
    "currentLane": "GENERAL or AGENCY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G10",
    "label": "IT VARs, MSPs and AV integrators",
    "guidance": "Procurement/resale, deployment, managed support, vendor/channel relationships",
    "boundary": "especially strong business-services fit",
    "primaryFacetIds": [
      "rr_i01",
      "rr_c01",
      "rr_c02",
      "rr_i02",
      "rr_c10",
      "rr_i04"
    ],
    "sourcePaths": [
      "vendor partners",
      "hardware/software procurement",
      "deployment",
      "managed services",
      "government contracts"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G11",
    "label": "Software implementation and technical consulting",
    "guidance": "Named vendor practice, migration/projects, managed support, specialized workforce",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_i02",
      "rr_c02",
      "rr_p01",
      "rr_c03",
      "rr_c10",
      "rr_c05"
    ],
    "sourcePaths": [
      "named vendor practices",
      "implementation/migration",
      "support/managed services",
      "case studies"
    ],
    "currentLane": "Management Consulting or GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G12",
    "label": "Cybersecurity",
    "guidance": "Expert testing/response plus managed services or proprietary platform",
    "boundary": "security software alone is a different model",
    "primaryFacetIds": [
      "rr_c12",
      "rr_c02",
      "rr_c03",
      "rr_i02",
      "rr_i04",
      "rr_s02"
    ],
    "sourcePaths": [
      "testing/response services",
      "managed security",
      "platform offering",
      "government capabilities"
    ],
    "currentLane": "GENERAL or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G13",
    "label": "Government technology contractors",
    "guidance": "Own contract identifiers, equipment + services, public procurement channels",
    "boundary": "serving a contractor does not establish own federal awards",
    "primaryFacetIds": [
      "rr_i04",
      "rr_c01",
      "rr_f03",
      "rr_c12",
      "rr_c02",
      "rr_c10"
    ],
    "sourcePaths": [
      "own contract vehicles/identifiers",
      "equipment/products",
      "technical services",
      "government case studies"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G14",
    "label": "Telecom and connectivity",
    "guidance": "Network operations, equipment, installation, recurring connections, wholesale/reseller channels",
    "boundary": "distinguish operator from vendor",
    "primaryFacetIds": [
      "rr_c01",
      "rr_c02",
      "rr_c09",
      "rr_c10",
      "rr_s01",
      "rr_i03"
    ],
    "sourcePaths": [
      "network coverage",
      "connectivity plans/pricing",
      "equipment/installations",
      "wholesale/reseller"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G15",
    "label": "Hosting and data centers",
    "guidance": "Physical capacity, colocated equipment, managed cloud/security, deployment projects",
    "boundary": "Actual infrastructure operation must be explicit; distinguish owned assets, leased capacity and cloud resale.",
    "primaryFacetIds": [
      "rr_i03",
      "rr_c02",
      "rr_c09",
      "rr_c01",
      "rr_f03",
      "rr_c12"
    ],
    "sourcePaths": [
      "data centers/facilities",
      "colocation",
      "managed cloud/security",
      "deployment",
      "ownership descriptions"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G16",
    "label": "Staffing, interpreting and workforce services",
    "guidance": "Assignments, payroll responsibility, contractor/employee distinction, remote/in-person delivery",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_p01",
      "rr_c03",
      "rr_c04",
      "rr_c05",
      "rr_c09",
      "rr_s03"
    ],
    "sourcePaths": [
      "staffing/placement",
      "specialties",
      "assignment delivery",
      "worker/employment terms",
      "platform",
      "payroll responsibility"
    ],
    "currentLane": "HR & Staffing or Translation & Linguistic Services",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G17",
    "label": "Accounting, management and specialist advisory",
    "guidance": "Projects + continuing services; specialist practice tools; member/client reporting",
    "boundary": "do not assume hourly billing",
    "primaryFacetIds": [
      "rr_c02",
      "rr_p01",
      "rr_c03",
      "rr_n02",
      "rr_c06",
      "rr_c12"
    ],
    "sourcePaths": [
      "practice/service pages",
      "ongoing service engagements",
      "client/member programs",
      "delivery methodology"
    ],
    "currentLane": "Management Consulting or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G18",
    "label": "Legal, investigation and risk services",
    "guidance": "Cases, investigations, expert reports, monitoring subscriptions, software + analysts",
    "boundary": "similarly named law firms require identity care",
    "primaryFacetIds": [
      "rr_p02",
      "rr_c12",
      "rr_c03",
      "rr_c11",
      "rr_c02",
      "rr_p01"
    ],
    "sourcePaths": [
      "investigations/cases",
      "legal/expert reports",
      "monitoring services",
      "platform/data",
      "company identity"
    ],
    "currentLane": "Law Firms & Legal Services or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G19",
    "label": "Market research and information services",
    "guidance": "Proprietary data, panels/research projects, subscriptions, memberships and advisory",
    "boundary": "free thought leadership is insufficient",
    "primaryFacetIds": [
      "rr_p03",
      "rr_c11",
      "rr_c02",
      "rr_c03",
      "rr_c09",
      "rr_p01"
    ],
    "sourcePaths": [
      "data/research products",
      "membership/subscription",
      "advisory/community",
      "methodology",
      "pricing"
    ],
    "currentLane": "Information & Document Management or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G20",
    "label": "Marketing, creative and PR agencies",
    "guidance": "Production + strategy + media, retainers/projects where explicit, vertical specialization",
    "boundary": "an agency serving healthcare is not a clinic",
    "primaryFacetIds": [
      "rr_m01",
      "rr_c02",
      "rr_c05",
      "rr_c04",
      "rr_c06",
      "rr_s03"
    ],
    "sourcePaths": [
      "production/strategy/media services",
      "campaign case studies",
      "staffing",
      "vertical practice pages"
    ],
    "currentLane": "AGENCY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G21",
    "label": "Promotional products and print services",
    "guidance": "Custom production/sourcing, client webstores, warehousing, affiliate back office",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_c07",
      "rr_r02",
      "rr_r03",
      "rr_n02",
      "rr_c10",
      "rr_f03"
    ],
    "sourcePaths": [
      "product catalog",
      "custom sourcing/production",
      "client stores",
      "warehousing",
      "affiliate services"
    ],
    "currentLane": "AGENCY or GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G22",
    "label": "Events, catering and experiences",
    "guidance": "Equipment rental, staffing, physical production, venue/program operations",
    "boundary": "do not generalize from one catering win",
    "primaryFacetIds": [
      "rr_m01",
      "rr_c08",
      "rr_p01",
      "rr_f03",
      "rr_c04",
      "rr_c05"
    ],
    "sourcePaths": [
      "equipment rentals",
      "production",
      "staffing",
      "venues/programs",
      "catering packages"
    ],
    "currentLane": "GENERAL or AGENCY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G23",
    "label": "Publishing and physical media",
    "guidance": "Catalog inventory, distribution, royalties, multiple imprints",
    "boundary": "an imprint is not automatically a legal entity",
    "primaryFacetIds": [
      "rr_m02",
      "rr_c11",
      "rr_m04",
      "rr_r02",
      "rr_r03",
      "rr_c06"
    ],
    "sourcePaths": [
      "catalog/imprints",
      "physical distribution",
      "rights/royalties",
      "publisher services",
      "channels"
    ],
    "currentLane": "MEDIA",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G24",
    "label": "Broadcasting, film, music and creator businesses",
    "guidance": "Advertising, subscriptions, licensing, production, rights-owner payouts",
    "boundary": "retain channel-specific model",
    "primaryFacetIds": [
      "rr_m03",
      "rr_m04",
      "rr_c11",
      "rr_m01",
      "rr_c10",
      "rr_c09"
    ],
    "sourcePaths": [
      "advertising/subscription/licensing",
      "production",
      "distribution",
      "creator/rights owner terms"
    ],
    "currentLane": "MEDIA",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G25",
    "label": "Franchisors and distributed brand networks",
    "guidance": "Franchise ownership versus corporate locations, brand support/shared services",
    "boundary": "do not assume every location is company-owned",
    "primaryFacetIds": [
      "rr_c06",
      "rr_n02",
      "rr_c10",
      "rr_c05",
      "rr_s03",
      "rr_c11"
    ],
    "sourcePaths": [
      "franchise model",
      "brand portfolio",
      "corporate locations",
      "franchisee services",
      "royalty disclosures"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G26",
    "label": "Training, coaching and membership",
    "guidance": "Courses/programs, subscriptions, instructor/partner delivery, events",
    "boundary": "exact payment/renewal terms need evidence",
    "primaryFacetIds": [
      "rr_p03",
      "rr_c02",
      "rr_c03",
      "rr_c11",
      "rr_c04",
      "rr_s03"
    ],
    "sourcePaths": [
      "courses/programs",
      "membership/pricing",
      "instructors/partners",
      "events",
      "renewal terms"
    ],
    "currentLane": "GENERAL or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G27",
    "label": "Healthcare practices, pharmacies and care groups",
    "guidance": "Practice rollups, local brands, central services, care plus products",
    "boundary": "Verify the target's own delivery, asset and transaction role; do not infer finance pain from its industry.",
    "primaryFacetIds": [
      "rr_h01",
      "rr_h02",
      "rr_c06",
      "rr_n02",
      "rr_o01",
      "rr_o05"
    ],
    "sourcePaths": [
      "practice/pharmacy portfolio",
      "central services",
      "care services",
      "products",
      "dated acquisitions"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G28",
    "label": "Clinical research and lab support",
    "guidance": "Contract studies, sample storage, specialist testing, documentation, instrument services",
    "boundary": "keep biotech product developers separate",
    "primaryFacetIds": [
      "rr_h03",
      "rr_c12",
      "rr_p01",
      "rr_f02",
      "rr_c08",
      "rr_c01"
    ],
    "sourcePaths": [
      "contract studies",
      "testing",
      "sample storage",
      "instrument services",
      "documentation"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G29",
    "label": "Biotech, diagnostics and commercialization",
    "guidance": "Funded development, clinical stage, manufacturing/outsourcing and commercialization milestones",
    "boundary": "funding alone is not ERP intent",
    "primaryFacetIds": [
      "rr_r01",
      "rr_r03",
      "rr_r02",
      "rr_h02",
      "rr_h03",
      "rr_c11"
    ],
    "sourcePaths": [
      "pipeline/development stage",
      "dated clinical/commercial milestones",
      "manufacturing partners",
      "product launches",
      "dated funding"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G30",
    "label": "Financial services, trading and insurance",
    "guidance": "Advisory practices, acquisition groups, underwriting platforms, settlement and shared/member services",
    "boundary": "these are distinct models, and the energy-trading example alone does not establish a recurring ICP",
    "primaryFacetIds": [
      "rr_c06",
      "rr_n02",
      "rr_c09",
      "rr_c03",
      "rr_s03",
      "rr_c11",
      "rr_o01"
    ],
    "sourcePaths": [
      "business/practice descriptions",
      "member/shared services",
      "platform/underwriting",
      "settlement terms",
      "dated acquisitions"
    ],
    "currentLane": "GENERAL or ADVISORY",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G31",
    "label": "Software, AI and developer infrastructure",
    "guidance": "Actual charging unit, channel model, implementation services, expert labor, embedded IP",
    "boundary": "vertical customer language does not describe vendor operations",
    "primaryFacetIds": [
      "rr_c09",
      "rr_c10",
      "rr_s02",
      "rr_s03",
      "rr_c02",
      "rr_c11",
      "rr_c03"
    ],
    "sourcePaths": [
      "pricing/charging unit",
      "reseller/white-label",
      "implementation",
      "managed/expert services",
      "provider/affiliate payout terms"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G32",
    "label": "Devices and software-enabled products",
    "guidance": "Own hardware/device offering with software/connectivity, installation and service",
    "boundary": "software tracking others' assets is different",
    "primaryFacetIds": [
      "rr_s01",
      "rr_c01",
      "rr_c09",
      "rr_r02",
      "rr_r03",
      "rr_c10"
    ],
    "sourcePaths": [
      "device/product catalog",
      "software/connectivity",
      "installation",
      "support/service",
      "manufacturing partners"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G33",
    "label": "Industrial, electronics and consumer products",
    "guidance": "Owned products, contract manufacture, dealer/direct channels, service attachment",
    "boundary": "outside core territory may be ineligible",
    "primaryFacetIds": [
      "rr_r02",
      "rr_r03",
      "rr_c01",
      "rr_c08",
      "rr_c10",
      "rr_f03"
    ],
    "sourcePaths": [
      "product catalog",
      "dealer/direct channels",
      "contract manufacture",
      "service/repair",
      "fulfillment"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G34",
    "label": "Agriculture, environmental technology and energy",
    "guidance": "Products plus field/advisory services, R&D versus commercialization, physical infrastructure",
    "boundary": "too varied for one strong ICP",
    "primaryFacetIds": [
      "rr_r01",
      "rr_r02",
      "rr_r03",
      "rr_c01",
      "rr_f03",
      "rr_c12"
    ],
    "sourcePaths": [
      "products",
      "field/advisory services",
      "physical infrastructure",
      "dated development/commercial milestones",
      "manufacturing partners"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  },
  {
    "id": "G35",
    "label": "Associations, nonprofits and funded programs",
    "guidance": "Member/affiliate services, program delivery, documented funders/grants",
    "boundary": "nonprofit status alone does not establish grant restrictions",
    "primaryFacetIds": [
      "rr_n01",
      "rr_n02",
      "rr_p03",
      "rr_c02",
      "rr_c04",
      "rr_c06"
    ],
    "sourcePaths": [
      "program pages",
      "member services",
      "funders/grants",
      "annual reports",
      "affiliate structure"
    ],
    "currentLane": "GENERAL",
    "territoryEffect": "none",
    "assignmentRule": "Research lens only. Use explicit business description; broad industry labels and customer verticals are not proof of the target's model."
  }
] as const;

export const OPERATING_LESSON_DATA = [
  {
    "id": "L01",
    "label": "Physical products and services coexist",
    "guidance": "Distinguish equipment/product sales, installation/project delivery and continuing service. Ordinary technical support does not establish a managed-service business.",
    "hypothesis": "Product, project and service costs may require a shared view; the target's pain remains unknown.",
    "facetIds": [
      "rr_c01",
      "rr_c07",
      "rr_c08"
    ]
  },
  {
    "id": "L02",
    "label": "Delivery scale can exceed employee count",
    "guidance": "Identify who sells the job, performs it, invoices the customer and pays outside providers. A directory/referral network alone does not prove delivery or payout obligations.",
    "hypothesis": "Provider costs and customer work may need reconciliation; contractor status must be established separately.",
    "facetIds": [
      "rr_c04",
      "rr_p01",
      "rr_s03"
    ]
  },
  {
    "id": "L03",
    "label": "Customer sites differ from company offices",
    "guidance": "Treat multi-site client service as distinct from own branches. Service territory alone does not establish hundreds of client sites.",
    "hypothesis": "Work and cost tracking by client, site and job is a hypothesis, not established pain.",
    "facetIds": [
      "rr_c05"
    ]
  },
  {
    "id": "L04",
    "label": "Software can deliver human services",
    "guidance": "Separate software sold to service providers from a platform through which the target performs or manages work; generic onboarding/support is insufficient.",
    "hypothesis": "Software and expert labor may need a common financial view.",
    "facetIds": [
      "rr_c03",
      "rr_s02"
    ]
  },
  {
    "id": "L05",
    "label": "Specialized operations may remain in place",
    "guidance": "Use explicit evidence for actual operational and finance tools; business model alone does not prove an installed system, replacement or broken integration.",
    "hypothesis": "Investigate the operations-to-finance handoff without assuming the niche tool must be replaced.",
    "facetIds": [
      "rr_o04",
      "rr_o05"
    ]
  },
  {
    "id": "L06",
    "label": "Brands and units matter beyond ownership labels",
    "guidance": "Preserve brand, subsidiary, franchise, partner, acquisition target and shared-service relationships as different facts. PE backing is not a substitute.",
    "hypothesis": "Consolidation may matter when separate books are explicit; multi-brand presence alone does not prove it.",
    "facetIds": [
      "rr_c06",
      "rr_n02",
      "rr_o01"
    ]
  },
  {
    "id": "L07",
    "label": "Recurring revenue has different mechanisms",
    "guidance": "Record the actual published unit: seats, capacity, consumption, transactions, devices or assignments. Subscription, variable charges, implementations and payouts remain separate.",
    "hypothesis": "Reconciliation difficulty is unverified until the prospect confirms it.",
    "facetIds": [
      "rr_c09",
      "rr_c10",
      "rr_s03"
    ]
  },
  {
    "id": "L08",
    "label": "Ownership and transaction role change the model",
    "guidance": "Distinguish merchant of record, asset owner/operator, outside-work coordinator, IP licensor and software vendor. Outside carriers do not prove a non-asset model.",
    "hypothesis": "Only the target's verified role supports a relevant operating hypothesis.",
    "facetIds": [
      "rr_t01",
      "rr_t02",
      "rr_m04",
      "rr_r03"
    ]
  }
] as const;

export const OPERATING_RECIPE_DATA = [
  {
    "id": "B01",
    "label": "Service integrators with several revenue streams",
    "branches": [
      {
        "all": [
          "rr_c01"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [
      "rr_c05"
    ],
    "guides": [
      "G06",
      "G07",
      "G10",
      "G14"
    ],
    "boundary": "C01 itself requires the complete equipment + installation + continuing-service offer.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c01"
    ]
  },
  {
    "id": "B02",
    "label": "Service networks with provider costs",
    "branches": [
      {
        "all": [
          "rr_c04",
          "rr_s03"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [
      "rr_c05"
    ],
    "guides": [
      "G01",
      "G03",
      "G05",
      "G16"
    ],
    "boundary": "Explicit billing/payout role is required; a provider directory does not suffice. Do not infer worker classification.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c04",
      "rr_s03"
    ]
  },
  {
    "id": "B03",
    "label": "Creative businesses with physical operations",
    "branches": [
      {
        "all": [
          "rr_c07"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [],
    "guides": [
      "G20",
      "G21"
    ],
    "boundary": "Confirm an agency/design role separately; C07 alone does not establish an agency industry.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c07"
    ]
  },
  {
    "id": "B04",
    "label": "Specialist expertise sold through technology",
    "branches": [
      {
        "all": [
          "rr_c03"
        ],
        "any": [
          "rr_c02",
          "rr_c11"
        ],
        "legacyAll": []
      }
    ],
    "optional": [],
    "guides": [
      "G12",
      "G18",
      "G19",
      "G31"
    ],
    "boundary": "The target must deliver expert work; software used by someone else's experts is insufficient. C11 can describe one-time IP licensing, so this candidate recipe does not establish ongoing paid access without explicit terms.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c03",
      "rr_c02",
      "rr_c11"
    ]
  },
  {
    "id": "B05",
    "label": "Operating groups with documented acquisitions",
    "branches": [
      {
        "all": [
          "rr_c06",
          "rr_o01"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [
      "rr_o05"
    ],
    "guides": [
      "G06",
      "G25",
      "G27",
      "G30"
    ],
    "boundary": "Require a dated acquisition and own shared-service structure; separate books remain unknown unless explicit.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c06",
      "rr_o01"
    ]
  },
  {
    "id": "B06",
    "label": "Project services with complex cost components",
    "branches": [
      {
        "all": [
          "rr_f03"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [],
    "guides": [
      "G07",
      "G08",
      "G09",
      "G22"
    ],
    "boundary": "Cost components and project work are observable; a margin or accounting problem remains a hypothesis.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_f03"
    ]
  },
  {
    "id": "B07",
    "label": "Transport with a precise operating model",
    "branches": [
      {
        "all": [
          "rr_t01"
        ],
        "any": [
          "rr_t03",
          "rr_t04"
        ],
        "legacyAll": [
          "non_asset_based_3pl"
        ]
      },
      {
        "all": [
          "rr_t02"
        ],
        "any": [
          "rr_t03",
          "rr_t04"
        ],
        "legacyAll": []
      }
    ],
    "optional": [],
    "guides": [
      "G01",
      "G02"
    ],
    "boundary": "Non-asset brokerage and fleet-plus-brokerage are separate branches. T01 alone must never imply non-asset ownership.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_t01",
      "rr_t03",
      "rr_t04",
      "rr_t02"
    ]
  },
  {
    "id": "B08",
    "label": "Media with money flowing to rights owners",
    "branches": [
      {
        "all": [
          "rr_c11",
          "rr_m04"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [
      "rr_m02"
    ],
    "guides": [
      "G23",
      "G24"
    ],
    "boundary": "Licensing revenue and outgoing royalties are separate facts; physical inventory is optional.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c11",
      "rr_m04"
    ]
  },
  {
    "id": "B09",
    "label": "Variable billing with services or reseller distribution",
    "branches": [
      {
        "all": [
          "rr_c09"
        ],
        "any": [
          "rr_c02",
          "rr_c10"
        ],
        "legacyAll": []
      }
    ],
    "optional": [],
    "guides": [
      "G10",
      "G14",
      "G31",
      "G32"
    ],
    "boundary": "Published billing units are facts; difficult reconciliation is a hypothesis.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_c09",
      "rr_c02",
      "rr_c10"
    ]
  },
  {
    "id": "B10",
    "label": "Practice or pharmacy groups with central operations",
    "branches": [
      {
        "all": [
          "rr_h01",
          "rr_n02"
        ],
        "any": [],
        "legacyAll": []
      }
    ],
    "optional": [
      "rr_h02"
    ],
    "guides": [
      "G27"
    ],
    "boundary": "Require ownership/management and shared services; a directory of clinics or customer list is insufficient.",
    "status": "research_hypothesis",
    "interpretation": "Cached conjunction of separately supported facts, not a new Jev probability or automatic grade. A combined commercial offer needs direct native evidence.",
    "facetIds": [
      "rr_h01",
      "rr_n02"
    ]
  }
] as const;
