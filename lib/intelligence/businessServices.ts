import { bucketForSubindustry } from "@/config/territory";

/** Research priorities, never membership rules, grades, or assertions about an account. */
export const BUSINESS_SERVICES_RESEARCH_VERSION = "business-services-v1";
type ResearchLane = { focus: string; topics: readonly string[]; paths: RegExp };
const GENERAL: ResearchLane = {
  focus: "Client service delivery, engagement margins, outside delivery costs, billing, collections, close and management reporting. Look for a stated process or change; a service offering alone does not establish pain or buying intent.",
  topics: ["project_billing", "recurring_revenue", "subcontractor_costs", "client_profitability", "project_financials", "systems_project", "close_reporting", "unbilled_work", "cash_working_capital", "government_work"],
  paths: /services?|solutions?|case.stud|projects?|contracts?|clients?|pricing|billing|capabilit/i,
};
const LANES: Record<string, ResearchLane> = {
  "HR & Staffing": {
    focus: "Staffing and executive search: placement/client margins, pay rates versus bill rates, timesheet approval, weekly payroll versus client collections, VMS deductions, ATS/payroll/finance handoffs, retained-search installments and contractor payments. Client vacancies are not the staffing firm's own hiring growth. ATS or payroll replacement is not automatically an ERP replacement.",
    topics: ["workforce_billing", "client_profitability", "cash_working_capital", "project_billing", "systems_project", "subcontractor_costs", "recurring_revenue", "unbilled_work", "close_reporting"],
    paths: /staff|placement|employers?|clients?|workforce|payroll|timesheet|contract|executive.search|solutions|services/i,
  },
  "Facilities Management & Commercial Cleaning": {
    focus: "Facilities and commercial cleaning: site/contract margins, labor scheduling and time capture, recurring service plus one-off work orders, mobilizing a newly won contract, supplies, subcontractors, branch reporting and invoice approvals. Customer buildings are not automatically the service company's own operating locations. Do not assume that NetSuite replaces specialized dispatch or field-service tools.",
    topics: ["recurring_revenue", "workforce_billing", "subcontractor_costs", "client_profitability", "project_billing", "project_financials", "government_work", "cash_working_capital", "systems_project"],
    paths: /facilit|clean|janitorial|maintenance|work.order|contract|services|case.stud|mobiliz/i,
  },
  "Management Consulting": {
    focus: "Consulting: project delivery, utilization and resource allocation, fixed-fee versus hourly engagements, project margin, unbilled time/WIP, reimbursable expenses, subcontractors, practice reporting and PSA-to-finance handoffs. Client transformation projects do not establish a systems project inside the consultancy.",
    topics: ["project_financials", "project_billing", "unbilled_work", "subcontractor_costs", "client_profitability", "systems_project", "recurring_revenue", "close_reporting", "investor_reporting"],
    paths: /consult|practice|expertise|project|engagement|services|case.stud|insight/i,
  },
  "Law Firms & Legal Services": {
    focus: "Legal services: matter economics, unbilled time and disbursements, collections, partner/practice/office reporting, case-management-to-finance handoffs, lateral group integration and firm consolidation. Keep client funds/trust accounting distinct from firm operating cash; specialized legal workflows may require partner configuration or integration. A client's merger is not the law firm's acquisition.",
    topics: ["unbilled_work", "client_profitability", "project_billing", "cash_working_capital", "financial_controls", "systems_project", "acquisition_integration", "close_reporting", "subcontractor_costs"],
    paths: /practice|matter|legal|attorney|partner|billing|services|firm|case.stud/i,
  },
  "Translation & Linguistic Services": {
    focus: "Translation/localization: language-project margins, freelance linguist costs, per-word/hour/project billing, rush/revision work, customer and vendor currencies, translation-management-to-finance handoffs and recurring managed language services. Translation volumes and vendor networks alone do not establish a process failure.",
    topics: ["subcontractor_costs", "project_billing", "project_financials", "client_profitability", "recurring_revenue", "workforce_billing", "systems_project", "unbilled_work", "government_work"],
    paths: /translat|localiz|linguist|interpre|vendor|language|services|pricing|case.stud/i,
  },
  "Information & Document Management": {
    focus: "Document services: recurring storage/retention plus scanning/retrieval/destruction projects, customer/site billing, usage charges, chain-of-custody system-to-finance handoffs, client profitability, equipment and outsourced processing. Documents stored for clients are not automatically owned inventory.",
    topics: ["recurring_revenue", "project_billing", "client_profitability", "subcontractor_costs", "systems_project", "financial_controls", "project_financials", "government_work", "fleet_costs"],
    paths: /document|records|scann|retrieval|storage|shredd|retention|services|pricing|case.stud/i,
  },
};
const AGENCY: ResearchLane = {
  focus: "Agencies and creative production: project/retainer delivery, client-funded media and production costs, freelancer/vendor commitments, scope changes, campaign margin, unbilled work, resource utilization and agency-of-record wins. A client's growth or acquisition is not the agency's own change; pass-through billings are not automatically net agency revenue.",
  topics: ["subcontractor_costs", "client_profitability", "project_financials", "recurring_revenue", "project_billing", "unbilled_work", "systems_project", "cash_working_capital", "media_rights"],
  paths: /agency|creative|production|campaign|portfolio|work|services|clients?|case.stud/i,
};
const MEDIA: ResearchLane = {
  focus: "Media, publishing, broadcasting and music: owned subscriptions, advertising insertion orders, licensing/royalties, contributor payments, rights catalogs, production/project costs, deferred revenue and multiple revenue streams. Specialized ad-serving and rights systems may remain integrated; do not infer their replacement.",
  topics: ["media_rights", "recurring_revenue", "subcontractor_costs", "project_billing", "client_profitability", "systems_project", "close_reporting", "cash_working_capital", "project_financials"],
  paths: /licens|royalt|rights|publish|advertis|subscription|rate.card|media.kit|production|services|terms/i,
};
const TRANSPORT: ResearchLane = {
  focus: "Transportation, freight, rental and moving: route/customer/fleet profitability, carrier/owner-operator settlements, fuel and accessorial charges, maintenance and asset costs, equipment leases, branch reporting, freight billing and TMS/dispatch-to-finance handoffs. Customer freight is not automatically owned inventory. Preserve the existing exclusion for true third-party logistics providers; do not imply that NetSuite replaces dispatch/TMS.",
  topics: ["fleet_costs", "client_profitability", "subcontractor_costs", "cash_working_capital", "systems_project", "recurring_revenue", "project_billing", "financial_controls", "government_work"],
  paths: /fleet|carrier|freight|transport|rental|moving|settlement|fuel|maintenance|services|terminals?|routes?/i,
};

// Current NetSuite TAM imports use these broader labels, while public discovery
// uses config/territory.ts. These aliases select questions; they never relabel accounts.
const OPERATIONAL_SUPPORT: ResearchLane = {
  focus: "Operational support services: first identify the actual service model from the source. For staffing/search, examine pay-versus-bill rates, timesheets, placement margins, payroll-to-collections timing and ATS/VMS handoffs; client vacancies are not the firm's own hiring. For outsourced onsite services, examine contract/site margins, labor, subcontractors and recurring/work-order billing. For translation, examine freelance linguist costs and language-project billing. For document services, examine retention/retrieval/scanning charges and system-to-finance handoffs. Do not assume every company does all of these or treats customer property as owned inventory.",
  topics: ["workforce_billing", "subcontractor_costs", "recurring_revenue", "client_profitability", "cash_working_capital", "systems_project", "project_billing", "unbilled_work", "government_work"],
  paths: /services?|staff|placement|workforce|payroll|contract|language|translat|document|records|scann|security|maintenance|solutions|case.stud/i,
};
const ADVISORY: ResearchLane = {
  focus: "Advisory services: establish the actual advisory practice from the source before applying a workflow. Examine engagement or matter profitability, retainers versus hourly/fixed fees, unbilled work, reimbursable costs, collections and practice/partner reporting. For legal firms distinguish case-management integration and client trust funds from operating cash. An adviser's client transaction or systems project is not the adviser's own event; do not assume specialized legal or regulated advisory tools will be replaced.",
  topics: ["client_profitability", "unbilled_work", "project_billing", "recurring_revenue", "financial_controls", "cash_working_capital", "systems_project", "close_reporting", "subcontractor_costs"],
  paths: /advis|practice|engagement|matter|legal|partner|services|billing|clients|case.stud/i,
};

function laneFor(subindustry: string | null): ResearchLane {
  if (subindustry && LANES[subindustry]) return LANES[subindustry];
  if (subindustry === "Agencies") return AGENCY;
  if (subindustry === "Media & Publishing") return MEDIA;
  if (subindustry === "Freight & Logistics" || subindustry === "Passenger Transportation") return TRANSPORT;
  if (subindustry === "Facilities Management") return LANES["Facilities Management & Commercial Cleaning"];
  if (subindustry === "Operational Support Services") return OPERATIONAL_SUPPORT;
  if (subindustry === "Advisory Services") return ADVISORY;
  if (subindustry === "Advertising & Marketing" || subindustry === "Multimedia & Graphic Design") return AGENCY;
  const bucket = subindustry ? bucketForSubindustry(subindustry) : null;
  if (bucket === "Media / Advertising / Publishing") return MEDIA;
  if (bucket === "Transportation / Logistics") return TRANSPORT;
  return GENERAL;
}

export function businessServicesResearchContext(subindustry: string | null): string {
  return `Business-services territory research lens (${subindustry || "specific subindustry not established"}): ${laneFor(subindustry).focus} This lens supplies questions, never company facts. Use only the supplied source as evidence; preserve facts, Jev interpretations and unknowns separately.`;
}

/** Worker bounds the selected questions to ten; we order them for this source. */
export function operatingTopicPriority(subindustry: string | null, sourceKind: string): readonly string[] {
  const lane = laneFor(subindustry);
  const source = /job|ats|career/i.test(sourceKind)
    ? ["systems_project", "finance_leadership", "close_reporting", "financial_controls", "project_financials"]
    : /news|press|feed/i.test(sourceKind)
      ? ["systems_project", "acquisition_integration", "finance_leadership", "investor_reporting"] : [];
  return [...new Set([...source, ...lane.topics, "close_reporting", "financial_controls", "investor_reporting", "government_work"])];
}

export function researchSourcePriority(url: string, subindustry: string | null, missingTopics: readonly string[]): number {
  let path: string;
  try { path = decodeURIComponent(new URL(url).pathname); } catch { return 0; }
  const missing = new Set(missingTopics);
  let score = laneFor(subindustry).paths.test(path) ? 6 : 0;
  if (/services?|solutions?|capabilit|case.stud|projects?|pricing|terms|contract/i.test(path)) score += 3;
  if (/career|jobs?/i.test(path) && ["systems_project", "finance_leadership", "close_reporting", "project_financials"].some(topic => missing.has(topic))) score += 4;
  if (/locations?|offices?|branches/i.test(path) && missing.has("multi_location")) score += 5;
  if (/about|companies|subsidiar|leadership/i.test(path) && missing.has("multi_entity")) score += 3;
  if (/news|press|acquis|announcement/i.test(path)) score += 2;
  if (/privacy|cookies|accessibility|login|sign.in/i.test(path)) score -= 10;
  return score;
}
