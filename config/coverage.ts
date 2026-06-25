/**
 * Slice universes for systematic TAM coverage. Each actor round-robins through
 * its universe (lib/ingest/coverage.ts) so runs never repeat — and the keyword
 * sets are tuned per actor's strength + the ERP/QuickBooks buying angles.
 */

// Major cities across the 32 territory regions (for geo-specific actors).
export const TERRITORY_CITIES = [
  "Los Angeles, CA", "San Diego, CA", "San Jose, CA", "San Francisco, CA", "Sacramento, CA", "Fresno, CA",
  "Houston, TX", "Dallas, TX", "San Antonio, TX", "Austin, TX", "Fort Worth, TX", "El Paso, TX",
  "Phoenix, AZ", "Tucson, AZ", "Mesa, AZ",
  "Denver, CO", "Colorado Springs, CO", "Aurora, CO",
  "Seattle, WA", "Spokane, WA", "Tacoma, WA",
  "Minneapolis, MN", "Saint Paul, MN",
  "Salt Lake City, UT", "Provo, UT",
  "Portland, OR", "Eugene, OR",
  "Las Vegas, NV", "Reno, NV",
  "Oklahoma City, OK", "Tulsa, OK",
  "Wichita, KS", "Overland Park, KS",
  "Boise, ID", "Omaha, NE", "Lincoln, NE",
  "Albuquerque, NM", "Cheyenne, WY", "Honolulu, HI", "Anchorage, AK",
  "Billings, MT", "Sioux Falls, SD", "Fargo, ND",
  "Chicago, IL", "Naperville, IL", "Springfield, IL",
  "Kansas City, MO", "Saint Louis, MO", "Springfield, MO",
  "Milwaukee, WI", "Madison, WI",
  "Des Moines, IA", "Cedar Rapids, IA",
  "Little Rock, AR", "San Juan, PR",
  "Vancouver, BC", "Calgary, AB", "Edmonton, AB",
];

// Google Maps category searches mapped to the IN-TERRITORY subindustries (SMB
// long-tail). Blocked industries (accounting, call centers, law, freight/3PL)
// are intentionally absent so we never spend Maps budget discovering them.
export const MAPS_CATEGORIES = [
  // HR & Staffing
  "staffing agency", "recruiting firm", "HR services firm", "employment agency",
  // Management Consulting
  "management consulting firm", "business consulting firm",
  // Facilities Management & Commercial Cleaning
  "commercial cleaning company", "janitorial service", "facilities management company",
  // Advertising / Marketing / Multimedia & Graphic Design
  "advertising agency", "marketing agency", "public relations firm", "graphic design studio",
  // Media & Internet / Music Production / Publishing / Newspapers
  "video production company", "media production company", "recording studio",
  "printing company", "magazine publisher", "newspaper publisher",
  // Information & Document Management / Translation
  "document management company", "translation services company",
  // Transportation / Logistics (freight & logistics KEPT; only true 3PLs are
  // filtered downstream by the is_3pl LLM gate — so no "3PL warehouse" term here)
  "trucking company", "freight company", "logistics company", "freight forwarder",
  "moving and storage company", "courier service",
  "truck rental company", "car rental agency", "charter bus company",
];

// Finance/ERP job-post keywords — tuned to the four ERP buying angles:
// QuickBooks pain, ERP/NetSuite implementation, systems roles, finance leaders.
export const ERP_JOB_KEYWORDS = [
  "Controller QuickBooks", "outgrew QuickBooks", "transitioning off QuickBooks",
  "ERP implementation", "NetSuite implementation", "Business Systems Analyst",
  "revenue recognition manager", "RevOps", "multi-entity accounting manager",
  "month-end close manager", "FP&A manager", "Accounting Manager QuickBooks",
  "Director of Finance ERP", "project accounting controller", "CFO QuickBooks",
  "ASC 606 accountant",
];

// Finance-leader titles for the Career Sites ATS actor.
export const FINANCE_TITLES = [
  "Controller", "CFO", "VP Finance", "Accounting Manager", "Director of Finance",
  "Revenue Accountant", "FP&A Manager",
];

// Leads Finder industries (lowercase enum values it accepts). Blocked verticals
// (accounting, legal) are excluded; freight & logistics KEPT (3PLs filtered by
// the is_3pl LLM gate, not here); extra kept-vertical industries widen coverage.
export const LEADS_INDUSTRIES = [
  "staffing & recruiting", "human resources", "outsourcing/offshoring",
  "management consulting", "transportation/trucking/railroad", "logistics & supply chain",
  "marketing & advertising", "public relations & communications", "graphic design",
  "facilities services", "events services",
  "media production", "broadcast media", "online media", "publishing",
  "information services", "translation & localization",
];
