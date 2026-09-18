"use client";
import { useEffect, useState } from "react";
import type { buildOperatingProfile } from "@/lib/intelligence/profiles";
type Result = { company: { name: string; subindustry: string | null }; profile: ReturnType<typeof buildOperatingProfile>; nextSources: string[] };
export default function OperatingProfile({ companyId }: { companyId: string }) {
  const [data, setData] = useState<Result | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    fetch(`/api/headhunter/intelligence/profile?companyId=${encodeURIComponent(companyId)}`, { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.json() : null).then(value => setData(value)).catch(() => {});
    return () => controller.abort();
  }, [companyId]);
  if (!data) return null;
  return <section className="mb-6 rounded-lg border bg-[var(--surface)] p-5" aria-label="Account operating profile">
    <h2 className="western text-2xl">{data.company.name}: operating profile</h2>
    {data.company.subindustry && <p className="text-sm text-[var(--text-muted)]">{data.company.subindustry}</p>}
    <p className="my-3 text-sm">{data.profile.note}</p>
    <div className="grid gap-3 md:grid-cols-2">{data.profile.topics.filter(topic => topic.state === "supported").map(topic =>
      <details key={topic.id} className="rounded border p-3"><summary className="cursor-pointer font-medium">{topic.label} · {topic.sources.length} {topic.sources.length === 1 ? "source" : "sources"}</summary>
        {topic.sources.map(source => <div key={source.observationId} className="mt-3 text-sm">
          <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-[var(--gold)] underline">{source.title}</a>
          <div className="text-xs text-[var(--text-muted)]">Event date: {source.eventDate?.slice(0, 10) ?? "Unknown"} · Collected {source.observedAt.slice(0, 10)}</div>
          <p className="mt-1 whitespace-pre-wrap">{source.contextPreview}{source.previewTruncated ? "…" : ""}</p>
          <span className="text-xs text-[var(--text-muted)]">Source context{source.previewTruncated ? " preview" : ""}; interpretation supported by the linked page.</span>
        </div>)}
      </details>)}</div>
    {data.profile.hypotheses.map((hypothesis, index) => <p key={index} className="mt-3 rounded border border-[var(--gold)] p-3 text-sm"><strong>Working hypothesis — unverified: </strong>{hypothesis.text}</p>)}
    {!!data.profile.unknowns.length && <p className="mt-4 text-sm text-[var(--text-muted)]"><strong>Still unknown: </strong>{data.profile.unknowns.join("; ")}.</p>}
    <p className="mt-2 text-xs text-[var(--text-muted)]">{data.profile.coverage.interpreted} of {data.profile.coverage.observations} current sources interpreted.</p>
    {data.nextSources.length > 0 && <button disabled={busy} className="mt-4 rounded border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => {
      setBusy(true); setMessage("");
      try {
        const response = await fetch("/api/headhunter/intelligence/profile", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ companyId }) });
        if (!response.ok) throw new Error();
        const result = await response.json();
        setMessage(`${result.sources} sources checked. ${result.outcomes.filter((outcome: string) => outcome === "queued").length} updates queued; ${result.outcomes.filter((outcome: string) => outcome === "source_failed").length} unavailable. Refresh after processing.`);
      } catch { setMessage("Could not refresh research sources. Existing evidence remains available."); }
      finally { setBusy(false); }
    }}>{busy ? "Researching…" : "Refresh sources for research gaps"}</button>}
    {message && <p role="status" className="mt-2 text-sm">{message}</p>}
  </section>;
}
