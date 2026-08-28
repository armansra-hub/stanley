import "server-only";

import { serviceClient } from "@/lib/supabase/server";
import { promoteCandidate } from "@/lib/db/triggers";
import { verifyCandidateEvidenceLLM } from "@/lib/triggers/classify";
import { fetchPublicHttpText, validatePublicHttpUrl } from "@/lib/triggers/urlSafety";
import type { CandidateEvidenceVerdict } from "@/lib/triggers/classify";

type CandidateRow = {
  id: string;
  company_id: string;
  company_name: string;
  type: string;
  summary: string;
  source_name: string | null;
  source_url: string | null;
};

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function evidenceTextFromHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20_000);
}

function isEvidencePage(rawUrl: string): boolean {
  try {
    const url = validatePublicHttpUrl(rawUrl);
    const path = url.pathname.replace(/\/+$/, "");
    return path.length > 1 && !/^\/(?:search|category|tag|author)$/i.test(path);
  } catch {
    return false;
  }
}

export function candidateVerdictIsPublishable(
  candidateType: string,
  verdict: CandidateEvidenceVerdict,
): boolean {
  return verdict.exact_company
    && verdict.concrete_event
    && verdict.confidence === "high"
    && verdict.event === candidateType
    && (candidateType !== "ma" || verdict.is_acquirer);
}

export async function reviewPendingCandidates(limit = 25): Promise<{
  checked: number;
  kept: number;
  rejected: number;
  promoted: number;
  deferred: number;
  deferred_fetch: number;
  deferred_evidence: number;
  deferred_verifier: number;
}> {
  const db = serviceClient();
  const { data, error } = await db.from("trigger_candidates")
    .select("id,company_id,company_name,type,summary,source_name,source_url")
    .is("verdict", null)
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(`candidate review load failed: ${error.message}`);
  const candidates = (data ?? []) as CandidateRow[];
  const companyIds = [...new Set(candidates.map((candidate) => candidate.company_id))];
  const { data: companies, error: companyError } = companyIds.length
    ? await db.from("companies").select("id,name,domain,website_raw,city,state").in("id", companyIds)
    : { data: [], error: null };
  if (companyError) throw new Error(`candidate company load failed: ${companyError.message}`);
  const companyById = new Map((companies ?? []).map((company) => [String(company.id), company]));
  const stats = {
    checked: 0, kept: 0, rejected: 0, promoted: 0, deferred: 0,
    deferred_fetch: 0, deferred_evidence: 0, deferred_verifier: 0,
  };

  // Serial on purpose: each decision performs one bounded evidence fetch and one
  // independent verifier call, and every completed decision is checkpointed.
  for (const candidate of candidates) {
    stats.checked++;
    const company = companyById.get(candidate.company_id);
    if (!company || !candidate.source_url || !isEvidencePage(candidate.source_url)) {
      const { data: decided } = await db.from("trigger_candidates").update({
        verdict: "reject",
        verdict_reason: "Automatic verification rejected a missing company or non-article evidence URL.",
        verdict_by: "stanley-auto-review",
        decided_at: new Date().toISOString(),
      }).eq("id", candidate.id).is("verdict", null).select("id").maybeSingle();
      if (decided) stats.rejected++;
      continue;
    }

    try {
      const evidence = await fetchPublicHttpText(candidate.source_url, {
        timeoutMs: 12_000,
        maxRedirects: 6,
        maxBytes: 1_000_000,
      });
      if (evidence.status < 200 || evidence.status >= 300 || !isEvidencePage(evidence.finalUrl)) {
        stats.deferred++;
        stats.deferred_fetch++;
        continue;
      }
      const extractedText = evidenceTextFromHtml(evidence.body);
      const isGoogleNewsGateway = candidate.source_name === "Google News"
        && new URL(evidence.finalUrl).hostname.toLowerCase() === "news.google.com";
      // Google News article gateways keep the RSS headline in executable page
      // state, which the HTML safety extractor intentionally removes. Preserve
      // the public RSS headline as evidence only for that exact article gateway;
      // ordinary homepages and generic source URLs remain invalid.
      const evidenceText = isGoogleNewsGateway
        ? `Google News RSS article headline: ${candidate.summary}\n${extractedText}`
        : extractedText;
      if (evidenceText.length < 80) {
        stats.deferred++;
        stats.deferred_evidence++;
        continue;
      }
      const verdict = await verifyCandidateEvidenceLLM({
        companyName: String(company.name ?? candidate.company_name),
        companyDomain: company.domain ? String(company.domain) : company.website_raw ? String(company.website_raw) : null,
        companyLocation: [company.city, company.state].filter(Boolean).join(", ") || null,
        expectedEvent: candidate.type,
        headline: candidate.summary,
        evidenceUrl: evidence.finalUrl,
        evidenceText,
      });
      if (!verdict) {
        stats.deferred++;
        stats.deferred_verifier++;
        continue;
      }
      const keep = candidateVerdictIsPublishable(candidate.type, verdict);
      const reason = `${keep ? "Verified" : "Rejected"} automatically: ${verdict.reason}`.slice(0, 1000);
      const { data: decided } = await db.from("trigger_candidates").update({
        verdict: keep ? "keep" : "reject",
        verdict_reason: reason,
        verdict_by: "stanley-auto-review",
        decided_at: new Date().toISOString(),
        ...(keep ? { source_url: evidence.finalUrl } : {}),
      }).eq("id", candidate.id).is("verdict", null).select("id").maybeSingle();
      if (!decided) continue;
      if (keep) {
        stats.kept++;
        if (await promoteCandidate(candidate.id)) stats.promoted++;
      } else stats.rejected++;
    } catch {
      // Network/model failures are transient. Keep the candidate pending so the
      // next hourly reviewer can retry; never convert uncertainty into a signal.
      stats.deferred++;
      stats.deferred_fetch++;
    }
  }
  return stats;
}
