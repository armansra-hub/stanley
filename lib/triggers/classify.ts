import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM news-event verifier (precision layer over the free regex classifier). Given a
 * company name + a publisher-stripped headline the regex already flagged as a
 * candidate event, it confirms the headline is genuinely ABOUT this company and a
 * real POSITIVE growth / ERP-readiness event, and returns the precise type (and for
 * M&A, whether this company is the ACQUIRER vs the target). Budget-gated by the
 * caller; this just makes the call. Opus 4.8 (configurable), thinking off (cheap +
 * fast for a one-line classification).
 */
const MODEL = process.env.MODEL_CLASSIFY || "claude-opus-4-8";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    about_company: { type: "boolean", description: "true ONLY if the headline is genuinely about THIS company — not a same-named different entity, not a coincidental phrase, not the publisher/byline." },
    event: {
      type: "string",
      enum: ["funding", "ma", "new_entity", "finance_hire", "gov_contract", "press", "none"],
      description: "The single positive growth / ERP-readiness event the headline reports about this company. 'funding'=raised capital; 'ma'=an acquisition/merger involving it; 'new_entity'=formed a new subsidiary/division/entity; 'finance_hire'=hired a finance leader (CFO/Controller/VP Finance); 'gov_contract'=won a government contract/award; 'press'=concrete expansion (new office/facility/location). 'none' if it is not a real positive growth event (e.g. being acquired, layoffs, an office relocation/downsizing, a lawsuit, an award, or a generic/coincidental mention).",
    },
    is_acquirer: { type: "boolean", description: "For event='ma' ONLY: true if THIS company is the BUYER/acquirer (a growth signal); false if it is the TARGET being acquired (not a signal). Ignore for other events." },
  },
  required: ["about_company", "event", "is_acquirer"],
};

export interface EventVerdict { about_company: boolean; event: "funding" | "ma" | "new_entity" | "finance_hire" | "gov_contract" | "press" | "none"; is_acquirer: boolean }

export async function classifyEventLLM(companyName: string, headline: string): Promise<EventVerdict | null> {
  try {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 200,
      thinking: { type: "disabled" },
      system: "You classify whether a news headline reports a real, POSITIVE growth / ERP-readiness event about a SPECIFIC small company (the kind of company outgrowing QuickBooks that would buy NetSuite). Be strict: reject headlines that are not about this exact company, that report the company being ACQUIRED/sold, layoffs, an office relocation, a lawsuit, an award, or only coincidentally contain the company's name or generic words. Return only the structured JSON.",
      messages: [{ role: "user", content: `Company: ${companyName}\nHeadline: ${headline}` }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = msg.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
    if (!text) return null;
    return JSON.parse(text) as EventVerdict;
  } catch {
    return null; // any failure → caller falls back to the regex verdict
  }
}
