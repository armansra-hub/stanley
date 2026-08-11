/**
 * Pure, fail-closed integrity gates shared by every finance-hire and Form D path.
 * These gates only decide whether a public signal is usable. They never infer or
 * change TAM qualification: an accounting firm can be signal-ineligible without
 * being record-dead or disqualified.
 */

export interface FinanceHireCompanyEvidence {
  name: string;
  record_dead?: boolean | null;
  description?: string | null;
  subindustry?: string | null;
  ns_industry?: string | null;
}

export type FinanceHireIneligibilityReason = "record_dead" | "finance_is_core_business";

export interface TriggerEvidence {
  type: string;
  summary?: string | null;
  source_name?: string | null;
  source_url?: string | null;
  metadata?: Record<string, unknown> | null;
}

const normalizeWords = (value: string | null | undefined) => String(value ?? "")
  .toLowerCase()
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

// High-precision company-name and industry markers. Being conservative here is
// intentional: a finance opening at a CPA/payroll/bookkeeping/tax provider is its
// delivery headcount, not evidence that an operating company is building finance.
const CORE_FINANCE_NAME = /(?:^|\s)(?:cpa|cpas|accounting|accountants?|bookkeep(?:er|ers|ing)?|payroll|tax|taxes|taxation)(?:\s|$)|(?:cpa|accounting|bookkeeping|payroll|tax)$/i;
const CORE_FINANCE_INDUSTRY = /\b(?:accounting|accountancy|bookkeeping|payroll services?|tax (?:preparation|advisory|services?)|certified public accountants?|cpa firms?|audit and assurance|assurance services?)\b/i;
const CORE_FINANCE_DESCRIPTION = /\b(?:cpa|accounting|bookkeeping|payroll|tax) firm\b|\b(?:provide|provides|providing|offer|offers|offering|specializ(?:e|es|ing) in)\b[^.]{0,80}\b(?:accounting|bookkeeping|payroll|tax preparation|tax advisory|outsourced cfo|fractional cfo)\b|\b(?:outsourced|fractional|virtual)\s+(?:accounting|bookkeeping|payroll|cfo|controller)\b/i;

export function financeHireEligibility(company: FinanceHireCompanyEvidence): {
  eligible: boolean;
  reason: FinanceHireIneligibilityReason | null;
} {
  if (company.record_dead === true) return { eligible: false, reason: "record_dead" };

  const name = normalizeWords(company.name);
  const industry = `${company.subindustry ?? ""} ${company.ns_industry ?? ""}`;
  const description = String(company.description ?? "");
  if (CORE_FINANCE_NAME.test(name) || CORE_FINANCE_INDUSTRY.test(industry) || CORE_FINANCE_DESCRIPTION.test(description)) {
    return { eligible: false, reason: "finance_is_core_business" };
  }
  return { eligible: true, reason: null };
}

export function isFinanceHireEligible(company: FinanceHireCompanyEvidence): boolean {
  return financeHireEligibility(company).eligible;
}

const CAREER_HOST = /(?:^|\.)(?:greenhouse\.io|lever\.co|ashbyhq\.com|smartrecruiters\.com|recruitee\.com|workable\.com|myworkdayjobs\.com|workdayjobs\.com|icims\.com|jobvite\.com|bamboohr\.com|wizehire\.com|indeed\.com|linkedin\.com)$/i;
const CAREER_PATH = /(?:^|\/)(?:careers?|jobs?|job-openings?|open-positions?|openings?|employment|opportunities|join-(?:our-)?team|work-with-us)(?:\/|$)/i;

function parsedHttpUrl(value: string | null | undefined): URL | null {
  try {
    const url = new URL(String(value ?? ""));
    if (!/^https?:$/.test(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** Legacy website scans fabricated `https://host/#Role` evidence. */
export function isFabricatedRootAnchor(value: string | null | undefined): boolean {
  const url = parsedHttpUrl(value);
  if (!url || !url.hash || url.hash === "#") return false;
  return url.pathname.replace(/\/+$/, "") === "";
}

/** A link that itself identifies a careers board, job list, or individual job. */
export function isCareerEvidenceUrl(value: string | null | undefined): boolean {
  const url = parsedHttpUrl(value);
  if (!url || isFabricatedRootAnchor(value)) return false;
  if (CAREER_HOST.test(url.hostname)) {
    return url.pathname !== "/" || url.search.length > 1;
  }
  return CAREER_PATH.test(url.pathname);
}

export function sourceRequiresCareerLink(sourceName: string | null | undefined): boolean {
  return /\b(?:careers?|job posting|job board|ats)\b/i.test(String(sourceName ?? ""));
}

/**
 * Finance-hire evidence must always be a concrete HTTP page. Career/ATS sources
 * additionally need a career/job-shaped URL; articles and LinkedIn posts may use
 * their own concrete paths.
 */
export function isFinanceHireEvidenceUrl(
  value: string | null | undefined,
  sourceName?: string | null,
): boolean {
  const url = parsedHttpUrl(value);
  if (!url || isFabricatedRootAnchor(value)) return false;
  if (sourceRequiresCareerLink(sourceName)) return isCareerEvidenceUrl(value);
  return url.pathname !== "/" || url.search.length > 1;
}

const LEGAL_SUFFIX = new Set([
  "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "ltd", "limited",
  "lp", "llp", "pllc", "plc", "holdco", "holding", "holdings", "enterprises", "the", "and",
]);
const GENERIC_ENTITY_WORD = new Set([
  "capital", "fund", "funds", "growth", "partners", "partner", "opportunities", "opportunity",
  "management", "investments", "investment", "ventures", "venture", "financial", "finance", "group",
]);

/** Normalize legal punctuation/suffixes without allowing substring containment. */
export function normalizeEntityIdentity(value: string | null | undefined): string {
  const raw = String(value ?? "")
    .replace(/\s*\((?:CIK|Filer|Issuer|Reporting)[^)]*\).*$/i, "")
    .replace(/\s*\([0-9]{6,}\).*$/, "")
    .replace(/\/[A-Z]{2}\/?\s*$/i, "");
  return normalizeWords(raw)
    .split(" ")
    .filter((token) => token && !LEGAL_SUFFIX.has(token))
    .join(" ");
}

/**
 * Exact normalized name equality is one useful Form D identity component, but it
 * is never sufficient by itself. A corroborated future implementation must also
 * bind a stable identifier or location before publishing a funding signal.
 */
export function strictEntityIdentityMatches(companyName: string, filerName: string): boolean {
  const company = normalizeEntityIdentity(companyName);
  const filer = normalizeEntityIdentity(filerName);
  if (!company || company.length < 4 || company !== filer) return false;
  const tokens = company.split(" ").filter(Boolean);
  return tokens.length > 0 && !tokens.every((token) => GENERIC_ENTITY_WORD.has(token));
}

export function isFormDTrigger(trigger: TriggerEvidence): boolean {
  return String(trigger.type) === "funding"
    && /SEC EDGAR|Form D/i.test(`${trigger.source_name ?? ""} ${trigger.summary ?? ""}`);
}

export function isLegacyFormDSearchTrigger(trigger: TriggerEvidence): boolean {
  if (!isFormDTrigger(trigger)) return false;
  const url = parsedHttpUrl(trigger.source_url);
  const exactFiling = Boolean(url
    && /(?:^|\.)sec\.gov$/i.test(url.hostname)
    && /\/Archives\/edgar\/data\/\d+\/\d{18}\/[^/]+$/i.test(url.pathname));
  return !exactFiling;
}

/**
 * Retired pre-verified-identity USAspending rows. The legacy signals sweep
 * attached awards by company-name substring alone; the public-growth pipeline
 * uses government-entity bindings and emits `federal_award` instead.
 */
export function isLegacyNameOnlyGovernmentTrigger(trigger: TriggerEvidence): boolean {
  return String(trigger.type) === "gov_contract"
    && /^USAspending$/i.test(String(trigger.source_name ?? "").trim());
}

function hasQuarantineMarker(metadata: Record<string, unknown> | null | undefined): boolean {
  const marker = metadata?.stanley_quarantine;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  // Only an explicit boolean true is an active audit decision. Inactive and
  // malformed legacy markers remain eligible for deterministic repair by 0044.
  return (marker as Record<string, unknown>).active === true;
}

/** Storage-level visibility/scoring gate that does not need company context. */
export function isPublishableTriggerEvidence(trigger: TriggerEvidence): boolean {
  if (hasQuarantineMarker(trigger.metadata)) return false;
  if (isLegacyNameOnlyGovernmentTrigger(trigger)) return false;
  // Form D discovery is retired until a filing can be corroborated by a second
  // stable company identifier/location. Exact name + exact filing URL alone is
  // not enough to distinguish same-named issuers.
  if (isFormDTrigger(trigger)) return false;
  if (new Set(["ma", "press", "new_entity", "finance_hire"]).has(String(trigger.type)) && isFabricatedRootAnchor(trigger.source_url)) return false;
  if (String(trigger.type) === "finance_hire" && !isFinanceHireEvidenceUrl(trigger.source_url, trigger.source_name)) return false;
  return true;
}

/** Adds the record/business-type guard used while rendering and recomputing. */
export function isPublishableTriggerForCompany(
  trigger: TriggerEvidence,
  company: FinanceHireCompanyEvidence,
): boolean {
  if (!isPublishableTriggerEvidence(trigger)) return false;
  return String(trigger.type) !== "finance_hire" || isFinanceHireEligible(company);
}

function formDFilerFromSummary(summary: string | null | undefined): string | null {
  const match = String(summary ?? "").match(/private capital raise\)\s*(?:—|-)\s*(.+?)\s*$/i);
  return match?.[1]?.trim() || null;
}

/** Deterministic reason used by the non-destructive cleanup operation. */
export function triggerQuarantineReason(
  trigger: TriggerEvidence,
  company: FinanceHireCompanyEvidence,
): string | null {
  if (hasQuarantineMarker(trigger.metadata)) return null;
  if (isLegacyNameOnlyGovernmentTrigger(trigger)) {
    return "legacy_name_only_government_identity_unverifiable";
  }
  if (new Set(["ma", "press", "new_entity", "finance_hire"]).has(String(trigger.type)) && isFabricatedRootAnchor(trigger.source_url)) {
    return "fabricated_root_anchor_evidence";
  }

  if (isFormDTrigger(trigger)) {
    const filer = formDFilerFromSummary(trigger.summary);
    if (!filer) return "form_d_identity_unverifiable";
    if (!strictEntityIdentityMatches(company.name, filer)) return "form_d_entity_mismatch";
    if (isLegacyFormDSearchTrigger(trigger)) return "legacy_form_d_nonfiling_evidence";
    return "form_d_identity_unverifiable";
  }

  if (String(trigger.type) === "finance_hire") {
    const eligibility = financeHireEligibility(company);
    if (!eligibility.eligible) return `finance_hire_${eligibility.reason}`;
    if (!isFinanceHireEvidenceUrl(trigger.source_url, trigger.source_name)) return "finance_hire_invalid_evidence_url";
  }

  return null;
}
