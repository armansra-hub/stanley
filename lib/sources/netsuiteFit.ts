/**
 * NetSuite operating-model fit rubric — REFERENCE ONLY, not a matcher.
 *
 * Arman's explicit rule (2026-07-30): "DO NOT DO JUST A KEYWORD SEARCH. I want you to
 * physically read every word of the linkedin description and linkedin posts. I also
 * want you to read all decision maker linkedin posts." Findings must come from a
 * reading agent's judgment over the FULL text — company description, every company
 * post, and every post from named decision-makers — with a verbatim quote the reader
 * chose, never a regex-selected snippet auto-generated from a pattern hit.
 *
 * This module exists to hand that reading agent a grounded, sourced rubric of what
 * NetSuite fit looks like in THIS territory, so its judgment is informed rather than
 * freeform. It is prompt material, not code that runs against text. See
 * lib/linkedin/readingPrompt.ts for how it's used.
 *
 * Sourced from researched NetSuite positioning for Business Services (staffing,
 * agencies, media/publishing, consulting, A&E, facilities management,
 * logistics/trucking/equipment rental). Confidence tiers reflect how technical/rare
 * each phrase is in ordinary corporate copy — "utilization" or "milestone billing"
 * rarely appears by accident; "grew from X to Y employees" is common enough to be
 * only a confirming signal, not a primary one.
 */

export type Confidence = "high" | "medium" | "low";

export interface FitTell {
  label: string;              // the badge text
  capability: string;         // the NetSuite capability this maps to
  confidence: Confidence;     // how rare/technical the language is — guidance for the reader, not a score
  subindustries?: string[];   // undefined = territory-wide
  examplePhrasings: string[]; // what this might sound like in a company's own words — illustrative, not exhaustive
}

export const NETSUITE_FIT_RUBRIC: FitTell[] = [
  // --- Cross-cutting -------------------------------------------------------
  { label: "multi-entity / multi-subsidiary", capability: "OneWorld consolidated multi-subsidiary ledger", confidence: "high",
    examplePhrasings: ["we operate across multiple entities/subsidiaries", "consolidated reporting across our offices", "licensed and operating in N states"] },
  { label: "outgrew QuickBooks", capability: "graduation from QBO's entity/user limits", confidence: "high",
    examplePhrasings: ["outgrew QuickBooks", "moved off spreadsheets", "needed investor-grade reporting", "our close process took weeks"] },
  { label: "disconnected point systems", capability: "unified ERP+CRM+PSA replacing siloed tools", confidence: "medium",
    examplePhrasings: ["single source of truth", "eliminate manual data entry between systems", "our systems don't talk to each other"] },
  { label: "multi-state payroll/compliance", capability: "SuitePeople multi-jurisdiction payroll", confidence: "medium",
    examplePhrasings: ["payroll across multiple states", "multi-state compliance", "HR/benefits across all our locations"] },
  { label: "stated headcount/revenue growth", capability: "scalability narrative — CONFIRMING signal only, common in ordinary copy", confidence: "low",
    examplePhrasings: ["grew from X to Y employees", "tripled headcount", "scaled from $XM to $YM", "expanded into N new markets"] },

  // --- Staffing / recruiting / HR services ---------------------------------
  { label: "pay/bill margin tracking", capability: "placement-level margin tracking (bill vs. pay rate)", confidence: "high",
    subindustries: ["Staffing", "HR Services"],
    examplePhrasings: ["bill rate / pay rate", "margin per placement", "markup on every placement"] },
  { label: "contingency/installment placement billing", capability: "percentage-based revenue allocation on placements", confidence: "high",
    subindustries: ["Staffing"],
    examplePhrasings: ["contingency-based placements", "installment billing", "retained search fees paid in installments"] },
  { label: "ATS/payroll integration gap", capability: "ERP as GL/AP hub bridging ATS and payroll", confidence: "medium",
    subindustries: ["Staffing"],
    examplePhrasings: ["our ATS doesn't sync with payroll", "manual transfer of placement data", "manage timesheets outside our accounting system"] },

  // --- Agencies / media & publishing -----------------------------------------
  { label: "media spend / campaign budget tracking", capability: "linking media buys and job costing into one ledger", confidence: "high",
    subindustries: ["Agencies", "Advertising, Media & Publishing"],
    examplePhrasings: ["media spend management", "campaign budget tracking", "manage ad spend across N clients"] },
  { label: "retainer drawdown billing", capability: "retainer billing schedules tied to project burn", confidence: "high",
    subindustries: ["Agencies", "Consulting", "Advisory Services"],
    examplePhrasings: ["retainer drawdowns", "bill against a retainer", "monthly retainer engagement"] },
  { label: "recurring/subscription revenue", capability: "SuiteBilling + ASC 606 revenue recognition", confidence: "medium",
    subindustries: ["Advertising, Media & Publishing"],
    examplePhrasings: ["subscription-based revenue", "renewal cycle", "circulation management"] },
  { label: "dual revenue-stream (ad + subscriber)", capability: "unified order mgmt across advertiser and subscriber customer types", confidence: "high",
    subindustries: ["Advertising, Media & Publishing"],
    examplePhrasings: ["advertiser and subscriber revenue", "ad sales and circulation", "print and digital revenue streams"] },

  // --- Consulting / professional services / A&E -----------------------------
  { label: "project-based accounting / job costing", capability: "project accounting linking time/expense to costing and billing", confidence: "high",
    subindustries: ["Consulting", "Architecture, Engineering & Design", "Advisory Services", "Agencies", "Facilities Management"],
    examplePhrasings: ["project-based accounting", "job costing", "track profitability by project/engagement"] },
  { label: "milestone / percentage-of-completion billing", capability: "fixed-fee, percent-complete and milestone billing on one engagement", confidence: "high",
    subindustries: ["Consulting", "Architecture, Engineering & Design", "Facilities Management"],
    examplePhrasings: ["percentage of completion", "milestone billing", "progress billing", "bill by project phase"] },
  { label: "time & materials billing", capability: "T&M billing rules tied to timesheets", confidence: "medium",
    subindustries: ["Consulting", "Agencies", "Staffing", "Architecture, Engineering & Design"],
    examplePhrasings: ["time and materials", "T&M engagement", "billed hourly against a rate card"] },
  { label: "utilization / billable-hours tracking", capability: "PSA resource utilization dashboards", confidence: "high",
    subindustries: ["Consulting", "Agencies", "Staffing", "Architecture, Engineering & Design"],
    examplePhrasings: ["utilization rate", "billable utilization", "bench time", "resource allocation across engagements"] },
  { label: "WIP / unbilled revenue reporting", capability: "work-in-progress reporting on the project ledger", confidence: "high",
    subindustries: ["Consulting", "Architecture, Engineering & Design", "Facilities Management", "Agencies"],
    examplePhrasings: ["WIP report", "work in progress reporting", "unbilled revenue", "unbilled time"] },

  // --- Logistics / trucking / freight / equipment rental --------------------
  { label: "fleet/asset lifecycle tracking", capability: "serial-level asset tracking, usage-triggered maintenance", confidence: "high",
    subindustries: ["Equipment Rental", "Freight & Logistics", "Passenger Transportation"],
    examplePhrasings: ["preventive maintenance program", "asset utilization tracking", "usage-based maintenance triggers", "fleet of N trucks"] },
  { label: "freight/load-level billing", capability: "automated freight billing with surcharges and accessorials", confidence: "high",
    subindustries: ["Freight & Logistics"],
    examplePhrasings: ["load-level profitability", "fuel surcharges", "accessorial charges", "driver settlements"] },

  // --- Facilities management --------------------------------------------------
  { label: "vendor/subcontractor cost consolidation", capability: "AP consolidation tied to site-level contract profitability", confidence: "medium",
    subindustries: ["Facilities Management", "Equipment Rental"],
    examplePhrasings: ["contractor management across N sites", "site-level contract profitability", "vendor/subcontractor network"] },
];

/** The rubric entries relevant to a lead — territory-wide tells plus any scoped to
 * its subindustry. Used to build the reading agent's prompt, never to auto-match text. */
export function rubricFor(subindustry?: string | null): FitTell[] {
  return NETSUITE_FIT_RUBRIC.filter((t) => !t.subindustries || (subindustry && t.subindustries.includes(subindustry)));
}
