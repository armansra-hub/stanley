import "server-only";

import { serviceClient, withServiceDeadline } from "@/lib/supabase/server";
import { promoteCandidate } from "@/lib/db/triggers";
import { CANDIDATE_VERIFIER_MODEL, candidateVerifierConfigured, verifyCandidateEvidenceLLM } from "@/lib/triggers/classify";
import { intelligenceEnabled } from "@/lib/intelligence/observations";
import { generationModelSupported, reserveGeneration, settleGeneration, secondsUntilNextMonth, type GenerationUsage } from "@/lib/intelligence/budget";
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
  verdict?: string | null;
  review_lease_token?: string;
  review_attempts?: number;
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

type ReviewStats = {
  checked: number;
  kept: number;
  rejected: number;
  promoted: number;
  deferred: number;
  deferred_fetch: number;
  deferred_evidence: number;
  deferred_verifier: number;
  deferred_budget?: number;
};

export async function reviewPendingCandidates(limit = 25, options: { deadlineMs?: number } = {}): Promise<ReviewStats> {
  if (intelligenceEnabled()) return reviewLeasedCandidates(limit, options.deadlineMs);
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

export function candidateRetrySeconds(attempt: number): number {
  return Math.min(86_400, 60 * 2 ** Math.min(Math.max(attempt, 1), 11));
}

/** Extra monitoring cadence uses fenced leases and a durable generation budget.
 * The disabled path above remains the existing serial reviewer. */
async function reviewLeasedCandidates(limit: number, suppliedDeadline?: number): Promise<ReviewStats> {
  const deadline = Math.min(suppliedDeadline ?? Infinity, Date.now() + 210_000);
  const stats: ReviewStats = { checked: 0, kept: 0, rejected: 0, promoted: 0, deferred: 0,
    deferred_fetch: 0, deferred_evidence: 0, deferred_verifier: 0, deferred_budget: 0 };
  return withServiceDeadline(deadline, async () => {
    const db = serviceClient();
    const { data: config, error: configError } = await db.from("intelligence_config").select("enabled").eq("id", 1).single();
    if (configError) throw new Error("Candidate review configuration unavailable");
    if (!config?.enabled) return stats;
    const bound = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 50) : 25;

    async function updateFenced(candidate: CandidateRow, patch: Record<string, unknown>) {
      const { data, error } = await db.from("trigger_candidates").update(patch)
        .eq("id", candidate.id).eq("review_lease_token", candidate.review_lease_token!)
        .gt("review_lease_until", new Date().toISOString()).is("promoted_trigger_id", null)
        .or("verdict.is.null,verdict.eq.keep").select("id").maybeSingle();
      if (error) throw new Error("Candidate checkpoint unavailable");
      return Boolean(data);
    }

    async function defer(candidate: CandidateRow, kind: "fetch" | "evidence" | "verifier" | "budget", reason: string, seconds = candidateRetrySeconds(candidate.review_attempts ?? 1)) {
      await updateFenced(candidate, { review_due_at: new Date(Date.now() + seconds * 1000).toISOString(),
        review_last_error: reason, review_lease_token: null, review_lease_until: null });
      stats.deferred++;
      const counter = `deferred_${kind}` as const;
      stats[counter] = (stats[counter] ?? 0) + 1;
    }

    async function review(candidate: CandidateRow, company: Record<string, unknown> | undefined) {
      stats.checked++;
      try {
        if (!company || company.status === "removed_from_tam" || !candidate.source_url || !isEvidencePage(candidate.source_url)) {
          if (await updateFenced(candidate, { verdict: "reject", verdict_reason: "Automatic verification rejected a missing account or non-article evidence URL.",
            verdict_by: "stanley-auto-review", decided_at: new Date().toISOString(), review_lease_token: null, review_lease_until: null, review_last_error: null })) stats.rejected++;
          return;
        }
        // A verified keep may have lost its publication receipt. Recover that exact
        // source without paying for another verifier request or choosing a newer row.
        if (candidate.verdict === "keep") {
          if (await promoteCandidate(candidate.id, { leaseToken: candidate.review_lease_token! })) stats.promoted++;
          else await defer(candidate, "verifier", "publication_incomplete");
          return;
        }
        const evidence = await fetchPublicHttpText(candidate.source_url, {
          timeoutMs: Math.max(1, Math.min(12_000, deadline - Date.now() - 20_000)), maxRedirects: 6, maxBytes: 1_000_000,
        });
        if (evidence.status < 200 || evidence.status >= 300 || !isEvidencePage(evidence.finalUrl)) {
          await defer(candidate, "fetch", "source_unavailable"); return;
        }
        const extracted = evidenceTextFromHtml(evidence.body);
        const gateway = candidate.source_name === "Google News" && new URL(evidence.finalUrl).hostname.toLowerCase() === "news.google.com";
        const evidenceText = gateway ? `Google News RSS article headline: ${candidate.summary}\n${extracted}` : extracted;
        if (evidenceText.length < 80) { await defer(candidate, "evidence", "insufficient_source_text"); return; }
        if (Date.now() > deadline - 20_000) { await defer(candidate, "verifier", "runtime_deferred", 60); return; }
        if (!candidateVerifierConfigured()) { await defer(candidate, "verifier", "verifier_not_configured", 3_600); return; }
        if (!generationModelSupported(CANDIDATE_VERIFIER_MODEL)) { await defer(candidate, "verifier", "unpriced_verifier_model", 86_400); return; }
        const reservation = await reserveGeneration(CANDIDATE_VERIFIER_MODEL);
        if (!reservation) { await defer(candidate, "budget", "budget_deferred", secondsUntilNextMonth()); return; }
        let usage: GenerationUsage | null = null;
        let verdict: CandidateEvidenceVerdict | null;
        try {
          verdict = await verifyCandidateEvidenceLLM({ companyName: String(company.name ?? candidate.company_name),
            companyDomain: company.domain ? String(company.domain) : company.website_raw ? String(company.website_raw) : null,
            companyLocation: [company.city, company.state].filter(Boolean).join(", ") || null,
            expectedEvent: candidate.type, headline: candidate.summary, evidenceUrl: evidence.finalUrl, evidenceText,
          }, { singleAttempt: true, deadlineMs: deadline - 5_000, onUsage: measured => { usage = measured; } });
        } finally {
          // Lost or malformed responses retain the reservation when usage is unknown.
          await settleGeneration(reservation, usage);
        }
        if (!verdict) { await defer(candidate, "verifier", "verifier_unavailable"); return; }
        const keep = candidateVerdictIsPublishable(candidate.type, verdict);
        const decided = await updateFenced(candidate, { verdict: keep ? "keep" : "reject",
          verdict_reason: `${keep ? "Verified" : "Rejected"} automatically: ${verdict.reason}`.slice(0, 1000),
          verdict_by: "stanley-auto-review", decided_at: new Date().toISOString(), review_last_error: null,
          ...(keep ? { source_url: evidence.finalUrl } : { review_lease_token: null, review_lease_until: null }),
        });
        if (!decided) return;
        if (!keep) { stats.rejected++; return; }
        stats.kept++;
        if (await promoteCandidate(candidate.id, { leaseToken: candidate.review_lease_token! })) stats.promoted++;
        else await defer(candidate, "verifier", "publication_incomplete");
      } catch {
        // No raw evidence/provider errors enter the retry ledger. Failed storage
        // checkpoints keep their lease for the next bounded recovery attempt.
        await defer(candidate, "fetch", "review_or_checkpoint_error").catch(() => {});
      }
    }

    while (stats.checked < bound && Date.now() < deadline - 35_000) {
      const { data, error } = await db.rpc("intelligence_claim_candidates", { p_limit: Math.min(2, bound - stats.checked) });
      if (error) throw new Error("Candidate lease claim unavailable");
      const candidates = (data ?? []) as CandidateRow[];
      if (!candidates.length) break;
      if (candidates.some(candidate => !candidate.review_lease_token)) throw new Error("Candidate claim missing lease");
      const { data: companies, error: companyError } = await db.from("companies")
        .select("id,name,domain,website_raw,city,state,status").in("id", [...new Set(candidates.map(candidate => candidate.company_id))]);
      if (companyError) throw new Error("Candidate account lookup unavailable");
      const byId = new Map((companies ?? []).map(company => [String(company.id), company as Record<string, unknown>]));
      await Promise.all(candidates.map(candidate => review(candidate, byId.get(candidate.company_id))));
      if (stats.deferred_budget) break;
    }
    return stats;
  });
}
