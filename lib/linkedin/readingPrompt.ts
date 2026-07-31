/**
 * Prompt builder for the LinkedIn/website reading pass.
 *
 * Arman's rule, verbatim (2026-07-30): "DO NOT DO JUST A KEYWORD SEARCH. I want you
 * to physically read every word of the linkedin description and linkedin posts. I
 * also want you to read all decision maker linkedin posts." This module exists so
 * that instruction is encoded once, in the prompt every reading agent receives —
 * not re-derived per call and not quietly weakened into a text-matching shortcut.
 *
 * The reading agent (a Sonnet subagent, per Arman's directive to do the reading on
 * Sonnet, not the orchestrating model) is handed the FULL text Codex fetched — the
 * company's LinkedIn description, every company post, and every post from named
 * decision-makers — plus the NetSuite-fit rubric as background knowledge, and is
 * asked to report only what it can quote verbatim. No finding without a quote.
 */
import { rubricFor, type FitTell } from "@/lib/sources/netsuiteFit";

export interface ReadingDoc { title: string | null; source: string | null; body: string; capturedAt?: string | null }
export interface ReadingLead {
  internalId: string;
  name: string;
  subindustry: string | null;
  domain: string | null;
  docs: ReadingDoc[]; // company description, company posts, decision-maker posts — every doc pushed for this lead
}

function formatRubric(tells: FitTell[]): string {
  return tells.map((t) =>
    `- ${t.label} [${t.confidence}] → ${t.capability}\n    e.g. "${t.examplePhrasings.join('", "')}"`,
  ).join("\n");
}

/** One lead's full reading prompt. Kept to one lead per prompt so "read every word"
 * is literal, not diluted across a batch the model might skim. */
export function buildReadingPrompt(lead: ReadingLead): string {
  const rubric = formatRubric(rubricFor(lead.subindustry));
  const docs = lead.docs.map((d, i) =>
    `--- DOCUMENT ${i + 1} — ${d.title ?? "untitled"} (source: ${d.source ?? "unknown"}${d.capturedAt ? `, ${d.capturedAt}` : ""}) ---\n${d.body.trim()}`,
  ).join("\n\n");

  return `You are reading everything publicly available on ONE company's LinkedIn presence \
and/or website for a NetSuite Account Executive's prospecting tool. Read every document below \
in full, start to finish. Do not skim, do not keyword-match, do not pattern-search — read it \
the way a human researcher would before a sales call.

COMPANY: ${lead.name}  (NetSuite internal ID ${lead.internalId})
SUBINDUSTRY: ${lead.subindustry ?? "unknown"}
DOMAIN: ${lead.domain ?? "unknown"}

You are looking for TWO different things. Report only what you can support with a VERBATIM \
QUOTE from the text below — no quote, no finding. If you find nothing, say so; that is a valid \
and expected result, not a failure.

## 1. TRIGGER EVENTS — something happened, with a rough date if stated
Job postings (a role they are hiring for — name the role), an announced expansion, a new \
product or service launch, an acquisition or merger, funding, a new office or market entry, \
a partnership announcement, an executive change. Only real, dated-or-recent events — not \
"we've always believed in growth" style copy, not customer testimonials, not the company \
describing itself in the abstract.

## 2. OPERATING-MODEL FIT — how this business actually runs, and whether that resembles a \
typical NetSuite customer in this territory
NetSuite's real strengths for this kind of company, for reference (this is background \
knowledge, not a checklist to search for — the finding must come from genuinely understanding \
what the post or description says the company does, not from spotting one of these phrases):

${rubric}

Read for genuine understanding: how do they make money, who pays them, what does their finance \
operation actually look like (do they mention a finance team, a controller, multi-entity \
structure, project-based billing, utilization, WIP, multi-state operations)? A company \
describing project-based accounting, multi-entity operations, or utilization tracking in its \
own words — even without using those exact terms — is real signal. A company just describing \
"who we are, what we do" in generic marketing language is not.

## DECISION-MAKER POSTS
Documents from named individuals (not the company page) carry extra weight — a person \
describing a real operational pain point or a stated hiring need is stronger evidence than \
company marketing copy. Note who said it.

## OUTPUT
For each finding, in this exact structure:
KIND: trigger | netsuite_fit | ops_profile
LABEL: short label (e.g. "hiring Controller", "project-based accounting", "multi-entity operations")
DETAIL: one sentence of your reasoning
EVIDENCE: the verbatim quote, exactly as written in the source
SOURCE: which document number it came from
CONFIDENCE: high | medium | low — your own judgment of how solid this reading is, not copied from the rubric

If a document is empty, boilerplate, or contains nothing relevant, say so explicitly rather \
than omitting it silently — I need to know you actually read it.

${docs || "(no documents provided)"}`;
}
