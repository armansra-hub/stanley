import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { SUBINDUSTRIES } from "@/config/territory";
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
    "company_name", "clearly_outside_us_canada", "in_territory", "subindustry", "ns_industry",
    "territory_fit", "description", "score_tier", "score_reason", "signals",
  ],
} as const;

const SYSTEM = `You classify companies for a NetSuite account executive's prospecting tool.

THESIS: NetSuite wins when operational/financial complexity outgrows QuickBooks — multi-entity, multi-location, multi-currency, project/job costing, revenue recognition, audit/compliance. Each signal is a proxy for a spike in one of those. Subindustry-specific (vertical) signals outrank generic growth.

Your job, returned as structured JSON:
0. company_name = the specific company the signals concern. If the provided name is a news headline or vague, extract the primary company — prefer the mid-market subject being hired into / acquired / expanding, not a large public acquirer or the newswire/publisher. If you CANNOT identify a clear, specific company name, set company_name to exactly "Name Unavailable" — do NOT invent a descriptive placeholder like "Bala Cynwyd accounting firm". Still classify territory from the context so the row is kept for manual review.
0b. clearly_outside_us_canada = true ONLY when the headline/context makes it obvious the company is based outside the United States or Canada (e.g., a Dutch firm, a UK acquisition target, "...in London"). If the location is US/Canada, ambiguous, or unstated, set it false. NEVER set it true merely because the location is unknown.
1. Classify the company into exactly ONE of the allowed subindustries, or "out_of_territory" if it fits none. This is a HARD gate. Set in_territory accordingly and give territory_fit 0–1.
2. ns_industry = the parent bucket ("Media / Advertising / Publishing", "Business Services", "Consulting", "Transportation / Logistics") or "out_of_territory".
3. description = one neutral sentence on what the company does.
4. For EACH input signal (keyed by its source_url), return: a signal type, a strength (weak/medium/strong), whether it is subindustry_relevant (true = vertical-specific pain, false = generic growth), and a one-sentence summary.
   HARD RULE: the summary must be derived ONLY from that signal's raw_excerpt. Never invent facts not in the excerpt.
5. score_tier (A/B/C): A = a capital/M&A event, especially corroborated by a finance/ops hire or QuickBooks→ERP pain; B = a single strong vertical-specific signal; C = generic growth only.

Allowed subindustries: ${SUBINDUSTRIES.join(", ")}.`;

export async function enrichCandidate(candidate: CandidateInput, model: string = MODEL_BULK): Promise<Enrichment | null> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const userText = JSON.stringify(
    {
      company: { name: candidate.name, website: candidate.website, state: candidate.state },
      signals: candidate.signals.map((s) => ({
        source_url: s.source_url,
        source_name: s.source_name,
        raw_excerpt: s.raw_excerpt,
      })),
    },
    null,
    2,
  );

  const msg = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM,
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
