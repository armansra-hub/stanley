import { OPERATING_FACET_DATA, OPERATING_GUIDE_DATA, OPERATING_LESSON_DATA, OPERATING_RECIPE_DATA } from "./operatingCatalogData";
import { catalogSha256 } from "./operatingCatalogHash";

/** Client-safe catalog; no provider, database, grading or filesystem dependency. */
export const OPERATING_CATALOG_RELEASE = "ring-ring-2026-09-24";
export const OPERATING_EXCLUDED_SOURCE_CATEGORIES = ["O06"] as const;
export const OPERATING_GUIDANCE_VERSION = "ring-ring-industry-guidance-v1";
export const OPERATING_QUESTION_PACK_VERSION = "operating-facets-v1";
export const OPERATING_CATALOG_SOURCE = {
  report: "research/ring-ring-icp-20260924/RESEARCH-REPORT.md",
  catalog: "research/ring-ring-icp-20260924/proposed-categories.json",
  catalogSha256: "f5231e18c422ee8f281a3de5bffd8504fe9215237f4bb50ceac89b9efeba543f",
  reportSha256: "265b8a6c00f727bb396ff7c73cff302529c49f4ecd999194116ff41e041e5a1e",
} as const;

export type OperatingFacetKind = "stable" | "dated" | "systems_context";
export type OperatingFacetId = typeof OPERATING_FACET_DATA[number]["id"];
export type OperatingGuideId = typeof OPERATING_GUIDE_DATA[number]["id"];
export type OperatingFacet = typeof OPERATING_FACET_DATA[number];
export type OperatingIndustryGuide = typeof OPERATING_GUIDE_DATA[number];
export const OPERATING_FACETS = OPERATING_FACET_DATA;
export const OPERATING_INDUSTRY_GUIDES = OPERATING_GUIDE_DATA;
export const OPERATING_COMMON_LESSONS = OPERATING_LESSON_DATA;
export const OPERATING_COMBINATION_RECIPES = OPERATING_RECIPE_DATA;
export const PUBLIC_OPERATING_FACETS = OPERATING_FACETS;
export const OPERATING_FACET_LABELS: Readonly<Record<OperatingFacetId, string>> = Object.fromEntries(
  OPERATING_FACETS.map(facet => [facet.id, facet.label]),
) as Record<OperatingFacetId, string>;

const FACETS_BY_ID = new Map<string, OperatingFacet>(OPERATING_FACETS.map(facet => [facet.id, facet]));
const GUIDES_BY_ID = new Map<string, OperatingIndustryGuide>(OPERATING_INDUSTRY_GUIDES.map(guide => [guide.id, guide]));
export function operatingFacet(id: string): OperatingFacet | undefined { return FACETS_BY_ID.get(id); }
export function operatingIndustryGuide(id: string): OperatingIndustryGuide | undefined { return GUIDES_BY_ID.get(id); }
export function isOperatingFacetId(id: unknown): id is OperatingFacetId { return typeof id === "string" && FACETS_BY_ID.has(id); }

/** Shape/label interpretation only. No rescoring or conversion to an invented probability. */
export type OperatingFacetDecision = "supported" | "not_supported" | "insufficient_evidence" | "conflicting";
export const OPERATING_FACET_DECISIONS = {
  supported: "Explicit supplied evidence establishes the complete predicate about the target's own business, with its required ownership, transaction role and date conditions.",
  not_supported: "Explicit supplied evidence contradicts the predicate for the target. Missing or incomplete evidence alone never qualifies.",
  insufficient_evidence: "The supplied evidence is absent, incomplete, ambiguous, about another company's/customer's activity, or does not establish the complete predicate or required date.",
  conflicting: "Supplied relevant evidence both supports and contradicts the target predicate and the conflict cannot be resolved from explicit source dates and attribution.",
} as const;

// Full decision definitions live once in shared state; short legends preserve the same native choices.
export const OPERATING_FACET_CHOICE_LABELS = {
  supported: "Complete target predicate explicitly established.",
  not_supported: "Explicit target evidence contradicts the predicate.",
  insufficient_evidence: "Predicate not established: evidence missing, incomplete, ambiguous or unrelated.",
  conflicting: "Unresolved relevant evidence supports and contradicts the predicate.",
} as const;

export type OperatingFacetNativeQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<OperatingFacetDecision, string>;
};

export function operatingFacetQuestion(id: string): OperatingFacetNativeQuestion | null {
  const facet = operatingFacet(id);
  if (!facet) throw new Error("unknown_operating_facet:" + id);
  return {
    type: "choice",
    instructions: facet.instructions + " Apply shared decision definitions. Return the native decision for this predicate only. Industry guides and historical examples are research context, never evidence about this target. Do not infer financial pain, purchase intent or a TAM grade.",
    criteria: { ...OPERATING_FACET_CHOICE_LABELS },
  };
}

export function operatingFacetDecision(answer: unknown): OperatingFacetDecision | null {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const value = answer as { type?: unknown; choice?: unknown };
  return value.type === "choice" && typeof value.choice === "string"
    && Object.hasOwn(OPERATING_FACET_DECISIONS, value.choice) ? value.choice as OperatingFacetDecision : null;
}

export function isSupportedOperatingFacetAnswer(answer: unknown): boolean {
  return operatingFacetDecision(answer) === "supported";
}

/** All35 guides are retained. No keyword-based industry omission or private win excerpts enter provider state. */
export function operatingCatalogSemanticContext() {
  return {
    guidanceVersion: OPERATING_GUIDANCE_VERSION,
    decisions: OPERATING_FACET_DECISIONS,
    policy: "Use these as research lenses, not facts about the target. Preserve seller/customer/partner roles, explicit ownership and transaction role, dates, and unknowns. Finance pain and purchase intent remain hypotheses. No TAM grading. Example companies are not supplied as target evidence.",
    industries: OPERATING_INDUSTRY_GUIDES.map(guide => ({
      id: guide.id, label: guide.label, lookFor: guide.guidance, boundary: guide.boundary,
    })),
    lessons: OPERATING_COMMON_LESSONS.map(lesson => ({
      id: lesson.id, guidance: lesson.guidance, hypothesis: lesson.hypothesis,
    })),
  };
}

export function operatingCatalogContext() {
  return JSON.stringify({ catalogVersion: OPERATING_CATALOG_VERSION, ...operatingCatalogSemanticContext() });
}

/** Automatically bind read-side visibility to actual definitions, questions and shared semantics. */
export function operatingCatalogContract() {
  return {
    schema: "ring-ring-operating-contract-v1", questionPack: OPERATING_QUESTION_PACK_VERSION,
    facets: OPERATING_FACETS.map(facet => ({ id: facet.id, definitionVersion: facet.definitionVersion,
      kind: facet.kind, definition: facet.definition, boundary: facet.boundary,
      instructions: facet.instructions, question: operatingFacetQuestion(facet.id) })),
    guidance: operatingCatalogSemanticContext(),
  };
}

export const OPERATING_CATALOG_CONTENT_HASH = catalogSha256(JSON.stringify(operatingCatalogContract()));
export const OPERATING_CATALOG_VERSION = "ring-ring-v1-" + OPERATING_CATALOG_CONTENT_HASH;

/** Planning is separate from interpretation. Candidate order is explicit; no silent slice or claimed applicability. */
export function operatingGuideFacetCandidates(guideIds: readonly string[]): OperatingFacetId[] {
  const result = new Set<OperatingFacetId>();
  for (const id of guideIds) {
    const guide = operatingIndustryGuide(id);
    if (!guide) throw new Error("unknown_operating_guide:" + id);
    for (const facetId of guide.primaryFacetIds) result.add(facetId);
  }
  return [...result];
}

/** Build an exact question set or fail. Caller explicitly partitions batches and persists deferred/context-only IDs. */
export function operatingFacetQuestions(ids: readonly string[], maxQuestions = 32): {
  questions: Record<string, OperatingFacetNativeQuestion>;
  requestedFacetIds: OperatingFacetId[];
  contextOnlyFacetIds: OperatingFacetId[];
} {
  if (!Number.isInteger(maxQuestions) || maxQuestions < 1 || maxQuestions > 32) throw new Error("invalid_question_limit");
  if (new Set(ids).size !== ids.length) throw new Error("duplicate_operating_facet");
  const questions: Record<string, OperatingFacetNativeQuestion> = {};
  const requestedFacetIds: OperatingFacetId[] = [];
  const contextOnlyFacetIds: OperatingFacetId[] = [];
  for (const id of ids) {
    const facet = operatingFacet(id);
    if (!facet) throw new Error("unknown_operating_facet:" + id);
    const question = operatingFacetQuestion(id);
    if (!question) contextOnlyFacetIds.push(facet.id);
    else { questions[id] = question; requestedFacetIds.push(facet.id); }
  }
  if (requestedFacetIds.length > maxQuestions) throw new Error("operating_question_limit_exceeded");
  return { questions, requestedFacetIds, contextOnlyFacetIds };
}

/** Same outer native limits; neither truncate evidence nor quietly drop questions to make a request fit. */
export function assertOperatingNativeBounds(input: { model: string; state: unknown; questions: Record<string, unknown> }) {
  const count = Object.keys(input.questions).length;
  if (count < 1 || count > 32) throw new Error("invalid_question_count");
  const bytes = new TextEncoder().encode(JSON.stringify(input)).length;
  if (bytes > 48_000) throw new Error("native_request_too_large");
  return { questionCount: count, requestBytes: bytes };
}

/** Discovery terms only: reading candidates cannot establish an operating fact. */
export const OPERATING_RESEARCH_QUERY_GROUPS: readonly { facets: readonly OperatingFacetId[]; terms: string }[] = [
  {
    "facets": [
      "rr_c01",
      "rr_c08",
      "rr_f01",
      "rr_f02",
      "rr_f03"
    ],
    "terms": "equipment OR installation OR maintenance OR calibration OR subcontractors"
  },
  {
    "facets": [
      "rr_c02",
      "rr_i02"
    ],
    "terms": "implementation OR \"managed services\" OR migration OR \"ongoing support\""
  },
  {
    "facets": [
      "rr_c03",
      "rr_s02"
    ],
    "terms": "platform OR \"expert services\" OR \"human in the loop\" OR analysts"
  },
  {
    "facets": [
      "rr_c04",
      "rr_p01",
      "rr_s03"
    ],
    "terms": "\"provider network\" OR staffing OR assignments OR payroll OR payouts"
  },
  {
    "facets": [
      "rr_c05"
    ],
    "terms": "\"national accounts\" OR \"customer sites\" OR \"multi-site\" OR \"service locations\""
  },
  {
    "facets": [
      "rr_c06",
      "rr_h01",
      "rr_n02"
    ],
    "terms": "\"our brands\" OR \"shared services\" OR \"practice group\" OR subsidiaries"
  },
  {
    "facets": [
      "rr_c07"
    ],
    "terms": "\"custom merchandise\" OR webstores OR fulfillment OR \"promotional products\""
  },
  {
    "facets": [
      "rr_c09"
    ],
    "terms": "pricing OR \"usage based\" OR consumption OR credits OR \"per transaction\""
  },
  {
    "facets": [
      "rr_c10"
    ],
    "terms": "reseller OR \"white label\" OR \"channel partners\" OR distributors"
  },
  {
    "facets": [
      "rr_c11",
      "rr_m04"
    ],
    "terms": "licensing OR royalties OR \"rights owners\" OR \"data subscription\""
  },
  {
    "facets": [
      "rr_c12",
      "rr_h03"
    ],
    "terms": "testing OR inspection OR compliance OR \"contract research\" OR laboratory"
  },
  {
    "facets": [
      "rr_t01",
      "rr_t02",
      "rr_t03",
      "rr_t04",
      "rr_t05"
    ],
    "terms": "brokerage OR forwarding OR fleet OR \"dedicated transportation\" OR \"last mile\" OR \"specialized freight\""
  },
  {
    "facets": [
      "rr_i01"
    ],
    "terms": "\"value added reseller\" OR procurement OR deployment OR \"managed IT\""
  },
  {
    "facets": [
      "rr_i03"
    ],
    "terms": "\"data centers\" OR colocation OR \"owned infrastructure\" OR \"managed cloud\""
  },
  {
    "facets": [
      "rr_i04"
    ],
    "terms": "\"contract vehicles\" OR \"government contracts\" OR \"technical services\" OR procurement"
  },
  {
    "facets": [
      "rr_p02",
      "rr_p03"
    ],
    "terms": "investigations OR litigation OR \"research membership\" OR advisory OR \"expert reports\""
  },
  {
    "facets": [
      "rr_m01"
    ],
    "terms": "experiential OR \"event production\" OR activation OR staging OR \"event staffing\""
  },
  {
    "facets": [
      "rr_m02",
      "rr_m03"
    ],
    "terms": "publishing OR imprints OR distribution OR advertising OR subscriptions OR broadcasting"
  },
  {
    "facets": [
      "rr_h01",
      "rr_h02",
      "rr_h03"
    ],
    "terms": "practices OR pharmacies OR \"care delivery\" OR diagnostics OR \"clinical research\""
  },
  {
    "facets": [
      "rr_s01"
    ],
    "terms": "devices OR hardware OR connectivity OR sensors OR \"software enabled\""
  },
  {
    "facets": [
      "rr_r01",
      "rr_r02",
      "rr_r03"
    ],
    "terms": "commercialization OR manufacturing OR dealers OR \"direct sales\" OR \"manufacturing partners\""
  },
  {
    "facets": [
      "rr_n01"
    ],
    "terms": "programs OR grants OR funders OR \"annual report\""
  },
  {
    "facets": [
      "rr_o01",
      "rr_o02"
    ],
    "terms": "acquisition OR integration OR \"carve out\" OR spinoff OR \"standalone company\""
  },
  {
    "facets": [
      "rr_o03",
      "rr_o04",
      "rr_o05"
    ],
    "terms": "ERP OR \"financial systems\" OR \"practice management\" OR \"transportation management\" OR \"separate books\" OR \"system migration\""
  }
];

/** Return every relevant theme. The existing discovery ledger rotates bounded query batches. */
export function catalogResearchQueries(facetIds: readonly string[]): string[] {
  for (const id of facetIds) if (!operatingFacet(id)) throw new Error("unknown_operating_facet:" + id);
  const requested = new Set(facetIds);
  return OPERATING_RESEARCH_QUERY_GROUPS.filter(group => group.facets.some(id => requested.has(id))).map(group => group.terms);
}
