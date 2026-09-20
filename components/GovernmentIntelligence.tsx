"use client";
import { useEffect, useState } from "react";
type Milestone = { id: string; label: string; milestone_date: string; source_url: string; federal_awards: { award_id: string | null } };
type Link = { trigger_id: string; method: string; native_result: unknown; triggers: { summary: string; source_url: string }; federal_awards: { award_id: string; source_url: string } };
type Data = { milestones: Milestone[]; links: Link[]; state: { last_completed_at: string | null; last_error: string | null } | null };
export default function GovernmentIntelligence({ companyId }: { companyId: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { let live = true; setData(null); setError(false);
    fetch(`/api/headhunter/contract-intelligence?companyId=${encodeURIComponent(companyId)}`, { cache: "no-store" })
      .then(async response => { if (!response.ok) throw new Error(); const next = await response.json(); if (live) setData(next); })
      .catch(() => { if (live) setError(true); }); return () => { live = false; };
  }, [companyId]);
  if (!data && !error) return null;
  if (error) return <p className="my-3 text-xs text-[var(--text-muted)]">Contract timing and announcement links are temporarily unavailable.</p>;
  if (!data || (!data.state && !data.links.length && !data.milestones.length)) return null;
  return <section className="my-4 rounded-lg border p-3 text-xs" aria-label="Contract timing and official records">
    <h3 className="font-semibold">Contract timing and official records</h3>
    <p className="mt-1 text-[var(--text-muted)]">Known dates can create a reason to research or reach out. They do not establish a renewal, ERP project or buying need. Missing option dates stay unknown.</p>
    {data.state?.last_error && <p className="mt-2">The latest contract pass needs recovery; saved findings remain below.</p>}
    {data.milestones.map(item => <div key={item.id} className="mt-2 border-t pt-2"><strong>{item.label}: {item.milestone_date}</strong><div>{item.federal_awards.award_id ?? "Award"} · <a href={item.source_url} target="_blank" rel="noreferrer" className="text-[var(--gold)]">Official record</a></div></div>)}
    {data.links.map(item => <div key={item.trigger_id} className="mt-2 border-t pt-2"><p>{item.triggers.summary}</p><p className="mt-1"><a href={item.triggers.source_url} target="_blank" rel="noreferrer" className="text-[var(--gold)]">Early announcement</a> → <a href={item.federal_awards.source_url} target="_blank" rel="noreferrer" className="text-[var(--gold)]">Official award {item.federal_awards.award_id}</a></p><p className="text-[var(--text-muted)]">{item.method === "exact_award_identifier" ? "Linked by exact award identifier." : "Jev matched these reports to the same award; raw interpretation below."}</p>{item.native_result ? <details><summary className="cursor-pointer text-[var(--gold)]">Raw Jev correspondence</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{JSON.stringify(item.native_result, null, 2)}</pre></details> : null}</div>)}
    {!data.links.length && !data.milestones.length && <p className="mt-2 text-[var(--text-muted)]">No known upcoming dates or linked announcements in the collected records yet.</p>}
    {data.state?.last_completed_at && <p className="mt-2 text-[var(--text-muted)]">Last complete contract pass: {new Date(data.state.last_completed_at).toLocaleString()}</p>}
  </section>;
}
