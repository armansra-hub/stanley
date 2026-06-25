import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { SUBINDUSTRIES } from "@/config/territory";
import { todayISO } from "@/lib/time";
import type { SignalType, SignalStrength, ScoreTier } from "@/lib/types";

/**
 * AI enrichment step (bulk, cost-sensitive) — territory classification, the
 * independent LLM tier, and a one-sentence summary per signal derived ONLY from
 * the supplied evidence. Uses structured outputs (output_config.format) on
 * MODEL_BULK. The deterministic 0–100 score is computed separately (lib/scoring).
 *
 * Hard rule: every summary is grounded in its raw_excerpt. Never invent facts.
 */

const MODEL_BULK = process.env.MODEL_BULK || "claude-haiku-4-5";

const SIGNAL_TYPES: SignalType[] = [
  "finance_hire", "pain_job_post", "hiring_velocity", "funding", "m_and_a",
  "new_entity", "gov_contract", "new_facility", "fleet_expansion", "new_service_line",
  "new_location", "new_service", "ex_netsuite_alum", "tech_stack", "intent",
  "job_post", "news",
];

export interface RawSignalInput {
  source_name: string;
  source_url: string; // REQUIRED evidence link
  raw_excerpt: string; // REQUIRED evidence text
  signal_date?: string | null; // when the event/post actually happened (ISO), if the source gives it
}

export interface CandidateInput {
  name: string;
  website?: string;
  state?: string | null;
  signals: RawSignalInput[];
}

export interface EnrichedSignal {
  source_url: string;
  type: SignalType;
  strength: SignalStrength;
  subindustry_relevant: boolean;
  summary: string;
}

export interface Enrichment {
  company_name: string; // canonical company, or exactly "Name Unavailable" if unidentifiable
  clearly_outside_us_canada: boolean; // true ONLY when context makes non-US/Canada location obvious
  clearly_too_large: boolean; // true if obviously a large enterprise (well above ~$30M revenue)
  clearly_too_small: boolean; // true ONLY if clearly under ~20 employees (micro/solo); unknown = false
  clearly_no_finance_team: boolean; // true ONLY if clearly no finance/accounting function at all; unknown = false
  junior_role_only: boolean; // true if the ONLY evidence is a junior/non-decision role and there's no other signal; blocked
  is_3pl: boolean; // true ONLY if a true third-party logistics provider (outsourced warehousing/fulfillment/brokerage); blocked
  already_on_netsuite: boolean; // true if evidence shows they ALREADY run NetSuite/modern ERP
  in_territory: boolean;
  subindustry: string; // one of SUBINDUSTRIES, or "out_of_territory"
  ns_industry: string;
  territory_fit: number; // 0–1
  description: string;
  score_tier: ScoreTier;
  score_reason: string;
  signals: EnrichedSignal[];
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    company_name: { type: "string" },
    clearly_outside_us_canada: { type: "boolean" },
    clearly_too_large: { type: "boolean" },
    clearly_too_small: { type: "boolean" },
    clearly_no_finance_team: { type: "boolean" },
    junior_role_only: { type: "boolean" },
    is_3pl: { type: "boolean" },
    already_on_netsuite: { type: "boolean" },
    in_territory: { type: "boolean" },
    subindustry: { type: "string", enum: [...SUBINDUSTRIES, "out_of_territory"] },
    ns_industry: { type: "string" },
    territory_fit: { type: "number" },
    description: { type: "string" },
    score_tier: { type: "string", enum: ["A", "B", "C"] },
    score_reason: { type: "string" },
    signals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source_url: { type: "string" },
          type: { type: "string", enum: SIGNAL_TYPES },
          strength: { type: "string", enum: ["weak", "medium", "strong"] },
          subindustry_relevant: { type: "boolean" },
          summary: { type: "string" },
        },
        required: ["source_url", "type", "strength", "subindustry_relevant", "summary"],
      },
    },
  },
  required: [
    "company_name", "clearly_outside_us_canada", "clearly_too_large", "clearly_too_small",
    "clearly_no_finance_team", "junior_role_only", "is_3pl", "already_on_netsuite", "in_territory",
    "subindustry", "ns_industry", "territory_fit", "description", "score_tier", "score_reason", "signals",
  ],
} as const;

function buildSystem(today: string): string {
  return `You classify companies for a NetSuite account executive's prospecting tool. TODAY'S DATE IS ${today}. We only care about CURRENT opportunities: events, job posts, news, and announcements from 2026 onward. Treat anything that clearly happened before 2026 as stale — reflect that in tier (a stale event is at most tier C) — and weight the MOST RECENT evidence the highest.

THESIS: NetSuite wins when operational/financial complexity outgrows QuickBooks — multi-entity, multi-location, multi-currency, project/job costing, revenue recognition, audit/compliance. Each signal is a proxy for a spike in one of those. Subindustry-specific (vertical) signals outrank generic growth.

Your job, returned as structured JSON:
0. company_name = the specific company the signals concern. If the provided name is a news headline or vague, extract the primary company — prefer the mid-market subject being hired into / acquired / expanding, not a large public acquirer or the newswire/publisher. If you CANNOT identify a clear, specific company name, set company_name to exactly "Name Unavailable" — do NOT invent a descriptive placeholder like "Bala Cynwyd firm". (Rows that stay "Name Unavailable" are discarded, so only use it when truly unidentifiable.)
0b. clearly_outside_us_canada = true ONLY when the headline/context makes it obvious the company is based outside the United States or Canada (e.g., a Dutch firm, a UK acquisition target, "...in London"). If the location is US/Canada, ambiguous, or unstated, set it false. NEVER set it true merely because the location is unknown.
0d. clearly_too_large = true if the company is clearly ABOVE ~$30M in annual revenue — a public company, a national/multinational brand, a household name, many hundreds/thousands of employees, or a well-known large firm (e.g., Crowe, C.H. Robinson, XPO, Lockheed, Aerotek). The ICP is $0–$30M revenue SMB / lower-mid-market; ~$30M is the HARD cutoff (a little over $10M is fine). If size is ambiguous, unstated, or plausibly under ~$30M, set it FALSE — never set it true just because size is unknown.
0e. clearly_too_small = true ONLY if the evidence clearly shows a micro-business under ~20 employees — a solo operator, "2-person shop", freelancer, a brand-new one-person LLC, "boutique team of 5". The floor is 20 employees: a company that small has no real finance complexity. If headcount is unknown, ambiguous, or plausibly 20+, set it FALSE — never set it true just because size is unknown.
0f. clearly_no_finance_team = true ONLY if it's clear the company has NO finance/accounting function whatsoever (e.g., explicitly states the owner does the books, no controller/bookkeeper/AP/AR at all). A company that needs/has finance staff is the ICP. If unknown or ambiguous, set it FALSE — we keep companies whose finance footprint is simply unstated.
0h. junior_role_only = true if the ONLY evidence here is the hiring/employment of a CLEARLY JUNIOR, non-decision-making role (e.g., staff/junior/associate accountant, bookkeeper, AP/AR clerk, billing/payroll specialist, coordinator, assistant, analyst, intern) AND there is no decision-maker and no other event signal. We only care about DECISION-MAKERS — finance/ops leadership (Controller, CFO, VP/Director/Head of Finance, Finance Manager, Controller, CEO/COO/President/Owner, VP/Head of Operations). If the evidence concerns such a decision-maker, OR there's a capital/M&A/expansion/QuickBooks-pain event, set junior_role_only = FALSE. When the role's seniority is unclear, set FALSE.
NEW-HIRE ACCURACY: if a signal claims someone is a "new hire" or "recently started" but provides NO verifiable start date (e.g., it's inferred only from a LinkedIn tenure filter, which resets on promotions/title changes), DO NOT assert they are new. Treat it as "a [title] is in seat" — a decision-maker-present signal — not a confirmed new-hire event, and keep the summary to what's verifiable.
0g. is_3pl = true ONLY for a true THIRD-PARTY LOGISTICS provider — a company whose core business is outsourced logistics for OTHER companies: third-party warehousing, order fulfillment / pick-pack-ship, distribution-center operation, or freight brokerage / 3PL "logistics solutions". These are blocked. DO NOT set it for freight or logistics companies broadly: asset-based truckload/LTL carriers, trucking lines, couriers/last-mile delivery, moving & storage, freight forwarders that move their own freight, marine/rail/air carriers, and general "transportation & logistics" operators are all KEPT (is_3pl=false). When in doubt, set FALSE.
0c. already_on_netsuite = true ONLY if the evidence shows the company ALREADY runs NetSuite or a comparable modern ERP — e.g., hiring a "NetSuite Administrator/Developer/Analyst", or text like "our NetSuite ERP / our Workday / our SAP". These are EXISTING ERP users, NOT QuickBooks-pain leads. If there's no such evidence, set it false.

ERP buying-signal priority (weight these HIGH, mark subindustry_relevant=true, and reflect in tier): (a) QuickBooks pain — "outgrew QuickBooks", "transitioning off QuickBooks", manual/spreadsheet close, QuickBooks-can't-scale; (b) actively maturing finance ops — hiring for "ERP implementation", "NetSuite implementation", "Business Systems Analyst", "RevOps", "ASC 606 / audit-ready", multi-entity consolidation; (c) a new finance leader (Controller/CFO/VP Finance) who previously used NetSuite at another company → type ex_netsuite_alum. (Note: hiring to ADMINISTER an existing NetSuite is already_on_netsuite, not a buying signal.)
1. Classify the company into exactly ONE of the allowed subindustries, or "out_of_territory" if it fits none. This is a HARD gate. Set in_territory accordingly and give territory_fit 0–1. BLOCKED (always "out_of_territory"): accounting / CPA / bookkeeping firms, TAX preparers / tax advisory / tax consultants (block these even if they call themselves "consultants" or "advisors"), call centers / answering services, and law / legal firms. (Freight & logistics IS in territory — only true 3PLs are filtered, via is_3pl above.)
2. ns_industry = the parent bucket ("Media / Advertising / Publishing", "Business Services", "Consulting", "Transportation / Logistics") or "out_of_territory".
3. description = one neutral sentence on what the company does.
4. For EACH input signal (keyed by its source_url), return: a signal type, a strength (weak/medium/strong), whether it is subindustry_relevant (true = vertical-specific pain, false = generic growth), and a one-sentence summary.
   HARD RULE: the summary must be derived ONLY from that signal's raw_excerpt. Never invent facts not in the excerpt. If a signal carries a date, a fresher date means stronger, more actionable intent.
5. score_tier (A/B/C): A = a recent (2026) capital/M&A event, especially corroborated by a finance/ops hire or QuickBooks→ERP pain; B = a single strong, recent vertical-specific signal; C = generic growth only, or anything stale/older.

Allowed subindustries: ${SUBINDUSTRIES.join(", ")}.`;
}

export async function enrichCandidate(candidate: CandidateInput, model: string = MODEL_BULK): Promise<Enrichment | null> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const userText = JSON.stringify(
    {
      company: { name: candidate.name, website: candidate.website, state: candidate.state },
      signals: candidate.signals.map((s) => ({
        source_url: s.source_url,
        source_name: s.source_name,
        raw_excerpt: s.raw_excerpt,
        signal_date: s.signal_date ?? "unknown",
      })),
    },
    null,
    2,
  );

  const msg = await client.messages.create({
    model,
    max_tokens: 1500,
    system: buildSystem(todayISO()),
    messages: [{ role: "user", content: userText }],
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
  } as Anthropic.MessageCreateParamsNonStreaming);

  const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Enrichment;
  } catch {
    return null;
  }
}
