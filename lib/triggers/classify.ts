import "server-only";
import Anthropic from "@anthropic-ai/sdk";

/**
 * LLM news-event verifier (precision layer over the free regex classifier). Given a
 * company name + a publisher-stripped headline the regex already flagged as a
 * candidate event, it confirms the headline is genuinely ABOUT this company and a
 * real POSITIVE growth / ERP-readiness event, and returns the precise type (and for
 * M&A, whether this company is the ACQUIRER vs the target). Budget-gated by the
 * caller; this just makes the call. Haiku is sufficient for this short structured
 * pre-filter; every queued candidate still requires the independent final review.
 * Automatic SDK retries are disabled because the regex result is a safe fallback.
 */
const MODEL = process.env.MODEL_CLASSIFY || "claude-haiku-4-5";
let client: Anthropic | null = null;
const classifierClient = () => (client ??= new Anthropic({ maxRetries: 0 }));

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

const EVIDENCE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    exact_company: { type: "boolean", description: "true only when the evidence is about the supplied operating company, not a same-name organization, product, publisher, person, or generic phrase" },
    concrete_event: { type: "boolean", description: "true only when the evidence page itself reports a dated concrete positive growth event" },
    event: { type: "string", enum: ["funding", "ma", "new_entity", "finance_hire", "gov_contract", "press", "none"] },
    is_acquirer: { type: "boolean", description: "for M&A, true only when the supplied company is the buyer/acquirer" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    reason: { type: "string", description: "short factual reason grounded in the supplied evidence" },
  },
  required: ["exact_company", "concrete_event", "event", "is_acquirer", "confidence", "reason"],
};

export interface CandidateEvidenceVerdict {
  exact_company: boolean;
  concrete_event: boolean;
  event: EventVerdict["event"];
  is_acquirer: boolean;
  confidence: "high" | "medium" | "low";
  reason: string;
}

function parseCandidateEvidenceVerdict(raw: string | undefined): CandidateEvidenceVerdict | null {
  if (!raw) return null;
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const value = JSON.parse(match[0]) as Partial<CandidateEvidenceVerdict>;
    const events = new Set<EventVerdict["event"]>(["funding", "ma", "new_entity", "finance_hire", "gov_contract", "press", "none"]);
    if (typeof value.exact_company !== "boolean"
      || typeof value.concrete_event !== "boolean"
      || !events.has(value.event as EventVerdict["event"])
      || typeof value.is_acquirer !== "boolean"
      || !new Set(["high", "medium", "low"]).has(String(value.confidence))
      || typeof value.reason !== "string") return null;
    return value as CandidateEvidenceVerdict;
  } catch {
    return null;
  }
}

export async function classifyEventLLM(companyName: string, headline: string): Promise<EventVerdict | null> {
  try {
    const msg = await classifierClient().messages.create({
      model: MODEL,
      max_tokens: 128,
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

/** Independent final verifier for queued news candidates. Unlike the cheap
 * headline classifier, this receives the fetched evidence page and fails closed. */
export async function verifyCandidateEvidenceLLM(input: {
  companyName: string;
  companyDomain: string | null;
  companyLocation: string | null;
  expectedEvent: string;
  headline: string;
  evidenceUrl: string;
  evidenceText: string;
}): Promise<CandidateEvidenceVerdict | null> {
  const system = "You are the final evidence verifier for a private-company growth monitor. Verify exact company identity and whether the supplied SOURCE PAGE itself reports the claimed concrete event. Reject same-name entities, publishers, products, generic mentions, predictions, directory pages, homepages, and unsupported claims. For M&A, reject the company when it is the target/seller. Use high confidence only when both identity and event are explicit in the evidence. Return only structured JSON.";
  const content = [
    `Company: ${input.companyName}`,
    `Company domain: ${input.companyDomain ?? "unknown"}`,
    `Company location: ${input.companyLocation ?? "unknown"}`,
    `Expected event: ${input.expectedEvent}`,
    `Candidate headline: ${input.headline}`,
    `Evidence URL: ${input.evidenceUrl}`,
    `Evidence text:\n${input.evidenceText.slice(0, 12_000)}`,
  ].join("\n");
  try {
    const msg = await classifierClient().messages.create({
      model: MODEL,
      max_tokens: 256,
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: EVIDENCE_SCHEMA } },
    } as Anthropic.MessageCreateParamsNonStreaming);
    const text = msg.content.find((block): block is Anthropic.TextBlock => block.type === "text")?.text;
    return parseCandidateEvidenceVerdict(text);
  } catch {
    // Some configured Anthropic models do not support output_config. Retry once
    // with the same strict contract expressed in the prompt, then validate every
    // returned field locally before allowing a publish decision.
    try {
      const msg = await classifierClient().messages.create({
        model: MODEL,
        max_tokens: 256,
        thinking: { type: "disabled" },
        system: `${system} Required keys: exact_company (boolean), concrete_event (boolean), event (funding|ma|new_entity|finance_hire|gov_contract|press|none), is_acquirer (boolean), confidence (high|medium|low), reason (string).`,
        messages: [{ role: "user", content }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      return parseCandidateEvidenceVerdict(msg.content.find((block): block is Anthropic.TextBlock => block.type === "text")?.text);
    } catch {
      return null;
    }
  }
}
