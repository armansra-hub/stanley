"use client";
import { useState } from "react";
import Link from "next/link";
import IntelligenceDismissButton from "./IntelligenceDismissButton";
import IntelligenceClassification from "./IntelligenceClassification";
import { DEFAULT_VISIBILITY_POLICY, jevPublicationRoute, visibilityReasonLabel, type VisibilityFinding } from "@/lib/intelligence/visibility";
export type FeedbackReason = "useful" | "wrong_company" | "old_event" | "irrelevant" | "not_now";
export type Observation = {
  id: string;
  company_id: string | null;
  company_name: string | null;
  company_status?: string;
  source_kind: string;
  source_url: string | null;
  title: string | null;
  event_date: string | null;
  observed_at: string;
  attributes: {
    [key: string]: unknown;
    signalType?: string;
    signalTypes?: string[];
    companyRelationship?: string;
    evidenceExcerpt?: string | null;
    operationalComplexity?: number;
    requiresResearch?: number;
  } | null;
  matchProbability?: number;
  feedback?: { reason: FeedbackReason; note?: string | null } | null;
  feedback_excluded?: boolean;
  public_priority_weight?: number;
};
const fieldClass = "w-full rounded-md border bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--gold)] disabled:opacity-50";
const feedbackOptions: [FeedbackReason, string][] = [
  ["useful", "Useful"], ["wrong_company", "Wrong company"], ["old_event", "Old event"],
  ["irrelevant", "Not relevant"], ["not_now", "Not now"],
];
const signalLabels: Record<string, string> = {
  funding: "Funding", new_entity: "New entity", ma: "Acquisition", gov_contract: "Government contract",
  finance_hire: "Finance hiring", press: "Expansion", erp_tech: "ERP / systems", hiring_velocity: "Hiring growth",
  employee_growth: "Employee growth", federal_award: "Federal award", federal_subaward: "Federal subaward",
  sam_award_notice: "SAM award notice", operating_change: "Operating change", news: "Company news", none: "No specific development",
};

function sourceLink(value: string | null): { url: string; host: string } | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? { url: url.href, host: url.hostname.replace(/^www\./, "") } : null;
  } catch { return null; }
}

function dateLabel(value: string | null, captured = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Unknown";
  return new Date(value).toLocaleString(undefined, captured
    ? { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }
    : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ageLabel(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Event age unknown";
  const days = Math.floor((Date.now() - Date.parse(value)) / 86_400_000);
  if (days < 0) return "Future event date";
  if (days === 0) return "Today";
  return `${days.toLocaleString()} ${days === 1 ? "day" : "days"} ago${days > DEFAULT_VISIBILITY_POLICY.eventMaxAgeDays ? " · Historical" : ""}`;
}

function probability(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? `${Math.round(value * 100)}%` : null;
}

export function EvidenceCard({ observation, busy, onFeedback, onOpenAccount, onStatus, statusBusy = false }: {
  onStatus?: (id: string, status: "new" | "dismissed") => Promise<boolean>;
  statusBusy?: boolean;
  onOpenAccount?: (id: string, name: string) => void;
  observation: Observation;
  busy: boolean;
  onFeedback: (reason: FeedbackReason | null, note: string) => Promise<boolean>;
}) {
  const [note, setNote] = useState(observation.feedback?.note ?? "");
  const [rawOpen, setRawOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const attributes = observation.attributes;
  const source = sourceLink(observation.source_url);
  const signals = [...new Set(attributes?.signalTypes ?? (attributes?.signalType ? [attributes.signalType] : []))];
  const match = probability(observation.matchProbability);
  const relationship = attributes?.companyRelationship;
  const relationshipLabel = relationship === "direct" ? "Company itself" : relationship === "related" ? "Related company" : relationship === "unrelated" ? "Different company" : "Company relationship unknown";
  const packets = (Array.isArray(attributes?.packetFindings) ? attributes.packetFindings : attributes ? [{ attributes, questionVersion: attributes.questionVersion, criteria: {} }] : []) as (VisibilityFinding & { publication?: { status?: string; reason?: string } })[];
  return <article className="rounded-lg border bg-[var(--surface)] p-4 sm:p-5">
    {onStatus && observation.company_id && <div className="mb-2 flex justify-end"><IntelligenceDismissButton companyId={observation.company_id} name={observation.company_name || "account"} status={observation.company_status} busy={statusBusy} onStatus={onStatus} /></div>}
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0 flex-1">
        {observation.company_id && onOpenAccount ? <button type="button" className="text-sm font-semibold text-[var(--gold)] hover:underline" onClick={() => onOpenAccount(observation.company_id!, observation.company_name || "Account")}>{observation.company_name || "Company name unavailable"}</button> : observation.company_id ? <Link className="text-sm font-semibold text-[var(--gold)] hover:underline" href={`/headhunter/intelligence?companyId=${encodeURIComponent(observation.company_id)}`}>{observation.company_name || "Company name unavailable"}</Link> : <p className="text-sm text-[var(--text-muted)]">Company not linked</p>}
        <h3 className="mt-1 break-words text-lg font-semibold leading-snug">{observation.title || "Untitled source observation"}</h3>
      </div>
      {match && <span className="rounded-full border px-2.5 py-1 text-xs text-[var(--gold)]" title="Model-estimated probability that the evidence matches this view’s question. This is not a factual accuracy score.">Question match {match}</span>}
    </div>
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {signals.map(signal => <span key={signal} className="rounded border bg-[var(--surface-2)] px-2 py-1">{signalLabels[signal] ?? signal.replace(/_/g, " ")}</span>)}
      <span className="rounded border px-2 py-1 text-[var(--text-muted)]">{attributes ? relationshipLabel : "Not yet interpreted"}</span>
      {attributes && typeof attributes.requiresResearch === "number" && attributes.requiresResearch >= 0.7 && <span className="rounded border px-2 py-1 text-[var(--gold)]">More context needed</span>}
    </div>
    <IntelligenceClassification attributes={attributes} />
    {packets.length > 0 && <details className="mt-3 rounded border p-3 text-xs">
      <summary className="cursor-pointer font-medium">Why this appears here or in Triggers</summary>
      <p className="mt-2 text-[var(--text-muted)]">All retained Jev findings remain available here. Trigger routing currently requires direct company attribution, at least 80% company relevance, 75% concrete development, a known date within 180 days, an eligible event classification and a selected source passage. Acquisitions require 80% acquirer probability. These are display rules, not another model review.</p>
      {packets.map((packet, index) => { const route = typeof packet.questionVersion === "string" && packet.attributes ? jevPublicationRoute(packet, observation.event_date) : null;
        return <div key={index} className="mt-3 border-t pt-2"><p>Packet {index + 1}: {packet.publication?.status ? packet.publication.status.replace(/_/g, " ") : "Publication not recorded"}{packet.publication?.reason ? ` · ${visibilityReasonLabel(packet.publication.reason)}` : route ? ` · Current routing: ${visibilityReasonLabel(route.reason)}` : ""}</p>
          <IntelligenceClassification attributes={packet.attributes} /></div>; })}
    </details>}
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--text-muted)]">
      <div><dt className="inline">Event: </dt><dd className="inline text-[var(--text)]">{dateLabel(observation.event_date)} <span className="text-[var(--text-muted)]">· {ageLabel(observation.event_date)}</span></dd></div>
      <div><dt className="inline">Captured: </dt><dd className="inline">{dateLabel(observation.observed_at, true)}</dd></div>
    </dl>
    {attributes?.evidenceExcerpt ? <blockquote className="mt-4 whitespace-pre-wrap break-words border-l-2 border-[var(--gold)] pl-4 text-sm leading-relaxed">{attributes.evidenceExcerpt}</blockquote> : <p className="mt-4 text-sm text-[var(--text-muted)]">{attributes ? "No supporting passage was selected. Open the source for context." : "This source is awaiting interpretation. Its event type and supporting passage are not yet established."}</p>}
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
      <span>{observation.source_kind.replace(/_/g, " ")}</span><span aria-hidden="true">·</span>
      {source ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="break-all text-[var(--gold)] hover:underline">Open {source.host} ↗</a> : <span>Source link unavailable</span>}
    </div>
    <div className="mt-4 border-t pt-3">
      <div className="flex flex-wrap items-center gap-1.5" aria-label="Feedback on this observation">
        {feedbackOptions.map(([reason, label]) => <button key={reason} type="button" disabled={busy} aria-pressed={observation.feedback?.reason === reason} onClick={() => void onFeedback(reason, note)} className={`rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-[var(--surface-2)] disabled:opacity-50 ${observation.feedback?.reason === reason ? "border-[var(--gold)] text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{label}</button>)}
        <button type="button" disabled={busy} onClick={() => setNoteOpen(open => !open)} aria-expanded={noteOpen} className="px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">{noteOpen ? "Hide note" : "Add context"}</button>
      </div>
      {noteOpen && <label className="mt-3 block text-xs text-[var(--text-muted)]">Optional context · saved with your next feedback selection
        <textarea rows={2} maxLength={500} value={note} disabled={busy} onChange={event => setNote(event.target.value)} className={`${fieldClass} mt-1`} placeholder="What would make this finding more useful?" />
      </label>}
      {observation.feedback && <p className="mt-2 text-xs text-[var(--text-muted)]">Saved feedback: {feedbackOptions.find(([reason]) => reason === observation.feedback?.reason)?.[1] ?? observation.feedback.reason}{observation.feedback.note ? ` · ${observation.feedback.note}` : ""}</p>}
      {observation.feedback && <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-[var(--text-muted)]">
        <button type="button" disabled={busy} className="text-[var(--gold)] underline" onClick={() => void onFeedback(null, "")}>Undo feedback</button>
        <span>{observation.feedback_excluded ? "Excluded from account profiles and matching views." : "Recorded feedback adjusts public priority by at most 10%, softened by four neutral examples. TAM grades stay unchanged."}</span>
      </div>}
      {attributes && <details className="mt-4 rounded border p-3" open={rawOpen} onToggle={event => setRawOpen(event.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-medium">Jev output</summary>
        <p className="mt-2 text-xs text-[var(--text-muted)]">Stored Jev judgments and probabilities, including individual evidence packets, topic references, coverage and publication outcomes when available. These are model outputs; feedback affects ranking separately.</p>
        <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{rawOpen ? JSON.stringify(attributes, null, 2) : ""}</pre>
      </details>}
    </div>
  </article>;
}
