"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { PipelineStage, Lead, LeadNote, LeadTask } from "@/lib/killlist/types";

type PlanItem = { action: { name: string; input: any }; describe: string };
type ChatMsg = { who: "you" | "stanley"; text: string };

const fmtDay = (iso: string | null | undefined, tz: string) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(iso)) : null;
const fmtDayTime = (iso: string | null | undefined, tz: string) =>
  iso ? new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : null;
const ago = (iso: string, tz: string) => fmtDay(iso, tz);

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.ok ? res.json() : null;
}

export default function KillListBoard({
  initialStages, initialLeads, usingSample, timezone, sampleNotes, sampleTasks,
}: {
  initialStages: PipelineStage[];
  initialLeads: Lead[];
  usingSample: boolean;
  timezone: string;
  sampleNotes: Record<string, LeadNote[]>;
  sampleTasks: Record<string, LeadTask[]>;
}) {
  const tz = timezone;
  const [stages, setStages] = useState<PipelineStage[]>(initialStages);
  const [leads, setLeads] = useState<Lead[]>(initialLeads);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null); // stage id getting a new lead
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  // ── drawer detail ──
  const [detail, setDetail] = useState<{ lead: Lead; notes: LeadNote[]; tasks: LeadTask[] } | null>(null);
  useEffect(() => {
    if (!drawerId) { setDetail(null); return; }
    const lead = leads.find((l) => l.id === drawerId);
    if (!lead) return;
    if (usingSample) { setDetail({ lead, notes: sampleNotes[drawerId] ?? [], tasks: sampleTasks[drawerId] ?? [] }); return; }
    setDetail({ lead, notes: [], tasks: [] });
    fetch(`/api/kill-list/lead?id=${drawerId}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (d?.lead) setDetail(d); });
  }, [drawerId]); // eslint-disable-line react-hooks/exhaustive-deps

  function applyBoard(r: any) {
    if (!r) return;
    if (r.stages) setStages(r.stages);
    if (r.leads) setLeads(r.leads);
    if (r.detail && drawerId && r.detail.lead_id === drawerId) {
      setDetail((d) => (d ? { ...d, notes: r.detail.notes, tasks: r.detail.tasks } : d));
    }
  }
  async function action(kind: string, body: Record<string, unknown>) {
    const r = await post("/api/kill-list/action", { kind, ...body });
    applyBoard(r);
    return r;
  }

  // ── log-a-call (voice/text debrief → note + extracted tasks) ──
  async function logCall(leadId: string, transcript: string): Promise<{ summary: string; taskCount: number } | null> {
    if (usingSample) {
      setDetail((d) => (d && d.lead.id === leadId ? { ...d, notes: [{ id: `tmp-${Date.now()}`, lead_id: leadId, body: transcript, author: "chatbot", created_at: new Date().toISOString() }, ...d.notes] } : d));
      return { summary: transcript, taskCount: 0 };
    }
    const r = (await post("/api/kill-list/log-call", { lead_id: leadId, transcript })) as any;
    if (!r) return null;
    if (r.leads) setLeads(r.leads);
    if (r.detail && r.detail.lead_id === drawerId) setDetail((d) => (d ? { ...d, notes: r.detail.notes, tasks: r.detail.tasks } : d));
    return { summary: r.summary, taskCount: r.taskCount };
  }

  // ── drag to move stage ──
  async function dropOn(stageId: string) {
    setOverStage(null);
    const id = dragId; setDragId(null);
    if (!id) return;
    const lead = leads.find((l) => l.id === id);
    if (!lead || lead.stage_id === stageId) return;
    setLeads((p) => p.map((l) => (l.id === id ? { ...l, stage_id: stageId } : l))); // optimistic
    if (!usingSample) await action("move_lead_stage", { id, stage_id: stageId });
  }

  async function createLead(stageId: string) {
    const name = newName.trim();
    setAdding(null); setNewName("");
    if (!name) return;
    if (usingSample) { setLeads((p) => [...p, { id: `tmp-${Date.now()}`, name, website: null, description: null, netsuite_url: null, stage_id: stageId, sort_in_stage: 0, last_activity_at: new Date().toISOString(), created_at: new Date().toISOString(), updated_at: new Date().toISOString(), open_tasks: 0, next_due_at: null }]); return; }
    await action("create_lead", { name, stage_id: stageId });
  }

  // ── stage management ──
  async function moveStage(idx: number, dir: -1 | 1) {
    const next = [...stages];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    setStages(next);
    if (!usingSample) await action("reorder_stages", { ordered_ids: next.map((s) => s.id) });
  }
  async function renameStage(id: string, name: string) {
    setStages((p) => p.map((s) => (s.id === id ? { ...s, name } : s)));
    if (!usingSample) await action("rename_stage", { id, name });
  }
  async function addStage() {
    const name = prompt("New stage name?")?.trim();
    if (!name) return;
    if (usingSample) { setStages((p) => [...p, { id: `tmp-${Date.now()}`, name, sort_order: p.length, color: "#8a7a63", archived: false }]); return; }
    await action("add_stage", { name });
  }

  // ── Stanley chat ──
  const [capture, setCapture] = useState("");
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const historyRef = useRef<any[]>([]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = chatScrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [chat, pending]);

  async function sendStanley(text: string) {
    const t = text.trim();
    if (!t || pending) return;
    setChat((c) => [...c, { who: "you", text: t }]);
    setCapture(""); setPlan([]); setPending(true);
    const nextHistory = [...historyRef.current, { role: "user", content: t }];
    const r = (await post("/api/kill-list/agent", { messages: nextHistory })) as any;
    setPending(false);
    if (!r) { setChat((c) => [...c, { who: "stanley", text: "Something went wrong — try again." }]); return; }
    historyRef.current = r.messages ?? nextHistory;
    if (r.stages) setStages(r.stages);
    if (r.leads) setLeads(r.leads);
    if (drawerId && r.leads && !usingSample) fetch(`/api/kill-list/lead?id=${drawerId}`).then((x) => (x.ok ? x.json() : null)).then((d) => { if (d?.lead) setDetail(d); });
    if (r.reply) setChat((c) => [...c, { who: "stanley", text: r.reply }]);
    setPlan(r.plan ?? []);
  }
  async function confirmPlan() {
    if (plan.length === 0 || pending) return;
    setPending(true);
    const r = (await post("/api/kill-list/agent/apply", { actions: plan.map((p) => p.action) })) as any;
    setPending(false);
    if (r?.stages) setStages(r.stages);
    if (r?.leads) setLeads(r.leads);
    setChat((c) => [...c, { who: "stanley", text: r?.results?.length ? `✓ ${r.results.join(" · ")}` : "Done." }]);
    historyRef.current = [...historyRef.current, { role: "user", content: `(Applied: ${plan.map((p) => p.describe).join("; ")})` }];
    setPlan([]);
  }

  // ── voice (Web Speech — Edge/Chrome; Brave disables it) ──
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const silenceRef = useRef<any>(null);
  const transcriptRef = useRef("");
  function toggleVoice() {
    if (listening) { clearTimeout(silenceRef.current); recogRef.current?.stop(); return; }
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!SR) { alert("This browser's speech recognition isn't available — Brave turns it off. Use Chrome or Edge."); return; }
    const r = new SR();
    r.lang = "en-US"; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
    transcriptRef.current = "";
    const arm = () => { clearTimeout(silenceRef.current); silenceRef.current = setTimeout(() => { try { r.stop(); } catch { /* */ } }, 4000); };
    r.onresult = (e: any) => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; transcriptRef.current = t; setCapture(t); arm(); };
    r.onerror = (e: any) => {
      clearTimeout(silenceRef.current); setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") alert("Microphone access is blocked. Allow the mic for this site and try again.");
      else if (e.error === "network") alert("The speech service is unavailable (Brave blocks it). Use Chrome or Edge.");
    };
    r.onend = () => { clearTimeout(silenceRef.current); setListening(false); if (transcriptRef.current.trim()) sendStanley(transcriptRef.current); };
    recogRef.current = r; setListening(true);
    try { r.start(); arm(); } catch { setListening(false); }
  }

  const now = Date.now();
  const matches = (l: Lead) => {
    if (query.trim() && !l.name.toLowerCase().includes(query.trim().toLowerCase()) && !(l.description ?? "").toLowerCase().includes(query.trim().toLowerCase())) return false;
    if (overdueOnly && !(l.next_due_at && new Date(l.next_due_at).getTime() < now)) return false;
    return true;
  };
  const leadsByStage = (sid: string | null) => leads.filter((l) => l.stage_id === sid && matches(l));

  return (
    <div className="mx-auto max-w-[1500px] px-6 py-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link href="/" className="mb-1 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">‹ Main Menu</Link>
          <div className="flex items-center gap-2">
            <h1 className="western text-2xl" style={{ color: "var(--gold)" }}>Stanley · Kill List</h1>
            {usingSample && <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: "var(--tier-b)", color: "var(--tier-b)" }}>SAMPLE DATA</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search leads…"
            className="rounded-md border bg-transparent px-3 py-1.5 text-xs outline-none placeholder:text-[var(--text-muted)]" style={{ borderColor: "var(--border)", color: "var(--text)" }}
          />
          <button onClick={() => setOverdueOnly((v) => !v)} className="rounded-md border px-3 py-1.5 text-xs" style={{ borderColor: overdueOnly ? "var(--blood)" : "var(--border)", color: overdueOnly ? "var(--blood)" : "var(--text-muted)" }} title="Show only leads with an overdue task">Overdue</button>
          <button onClick={addStage} className="rounded-md border px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" style={{ borderColor: "var(--border)" }}>+ Stage</button>
        </div>
      </div>

      {/* Stanley bar */}
      <div className="mb-4 flex items-center gap-2 rounded-lg border px-4 py-2" style={{ borderColor: "var(--border)", background: "rgba(31,22,13,0.6)" }}>
        <span className="western text-sm" style={{ color: "var(--gold)" }}>Stanley</span>
        <input
          value={capture} onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendStanley(capture)}
          placeholder="Add a lead, log a note, set a task…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
        />
        <button onClick={toggleVoice} className="rounded p-1 text-lg" title={listening ? "Stop" : "Speak"} style={{ color: listening ? "var(--blood)" : "var(--text-muted)" }}>{listening ? "⏹" : "🎙️"}</button>
        <button onClick={() => sendStanley(capture)} disabled={pending} className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">{pending ? "…" : "Send"}</button>
      </div>
      {(chat.length > 0 || plan.length > 0) && (
        <div className="mb-5 space-y-3">
          {chat.length > 0 && (
            <div ref={chatScrollRef} className="max-h-[5rem] space-y-1.5 overflow-y-auto rounded-md border px-4 py-2" style={{ borderColor: "var(--border)", background: "rgba(31,22,13,0.6)" }}>
              {chat.slice(-50).map((m, i) => (
                <p key={i} className="text-sm leading-snug">
                  <span className="western mr-2 text-xs" style={{ color: m.who === "stanley" ? "var(--gold)" : "var(--text-muted)" }}>{m.who === "stanley" ? "Stanley" : "You"}</span>
                  <span style={{ color: m.who === "stanley" ? "var(--text)" : "var(--text-muted)" }}>{m.text}</span>
                </p>
              ))}
              {pending && <p className="text-xs text-[var(--text-muted)]">Stanley is thinking…</p>}
            </div>
          )}
          {plan.length > 0 && (
            <div className="rounded-md border px-4 py-3" style={{ borderColor: "var(--blood)", background: "rgba(60,16,16,0.4)" }}>
              <p className="mb-2 text-xs font-medium" style={{ color: "var(--blood)" }}>Confirm</p>
              <ul className="mb-3 space-y-1 text-sm">{plan.map((p, i) => <li key={i}>• {p.describe}</li>)}</ul>
              <div className="flex gap-2">
                <button onClick={confirmPlan} disabled={pending} className="rounded-md bg-[var(--blood)] px-3 py-1 text-xs font-medium text-white">{pending ? "…" : "Confirm"}</button>
                <button onClick={() => setPlan([])} className="rounded-md border px-3 py-1 text-xs" style={{ borderColor: "var(--border)" }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Kanban */}
      <div className="flex gap-4 overflow-x-auto pb-4">
        {stages.map((stage, idx) => {
          const colLeads = leadsByStage(stage.id);
          return (
            <div
              key={stage.id}
              onDragOver={(e) => { e.preventDefault(); setOverStage(stage.id); }}
              onDragLeave={() => setOverStage((s) => (s === stage.id ? null : s))}
              onDrop={() => dropOn(stage.id)}
              className="flex w-72 shrink-0 flex-col rounded-lg border"
              style={{ borderColor: overStage === stage.id ? "var(--gold)" : "var(--border)", background: overStage === stage.id ? "rgba(201,162,74,0.06)" : "rgba(20,13,7,0.5)" }}
            >
              <div className="flex items-center justify-between border-b px-3 py-2" style={{ borderColor: "var(--border)" }}>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: stage.color ?? "var(--text-muted)" }} />
                  <input
                    defaultValue={stage.name}
                    onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== stage.name) renameStage(stage.id, v); }}
                    className="western bg-transparent text-sm outline-none" style={{ color: "var(--gold)", width: `${Math.max(stage.name.length, 4)}ch` }}
                  />
                  <span className="text-xs text-[var(--text-muted)]">{colLeads.length}</span>
                </div>
                <div className="flex items-center gap-0.5 text-[var(--text-muted)]">
                  <button onClick={() => moveStage(idx, -1)} className="px-1 hover:text-[var(--text)]" title="Move left">◀</button>
                  <button onClick={() => moveStage(idx, 1)} className="px-1 hover:text-[var(--text)]" title="Move right">▶</button>
                </div>
              </div>

              <div className="flex-1 space-y-2 p-2">
                {colLeads.map((l) => (
                  <button
                    key={l.id}
                    draggable
                    onDragStart={() => setDragId(l.id)}
                    onDragEnd={() => setDragId(null)}
                    onClick={() => setDrawerId(l.id)}
                    className="block w-full rounded-md border px-3 py-2 text-left transition-colors hover:border-[var(--gold)]"
                    style={{ borderColor: "var(--border)", background: "rgba(31,22,13,0.7)", opacity: dragId === l.id ? 0.4 : 1 }}
                  >
                    <div className="font-medium" style={{ color: "var(--text)" }}>{l.name}</div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
                      {(l.open_tasks ?? 0) > 0 && <span>{l.open_tasks} task{l.open_tasks === 1 ? "" : "s"}</span>}
                      {l.next_due_at && <span style={{ color: "var(--gold)" }}>due {fmtDay(l.next_due_at, tz)}</span>}
                      {l.last_activity_at && <span className="ml-auto">· {ago(l.last_activity_at, tz)}</span>}
                    </div>
                  </button>
                ))}

                {adding === stage.id ? (
                  <input
                    autoFocus value={newName} onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") createLead(stage.id); if (e.key === "Escape") { setAdding(null); setNewName(""); } }}
                    onBlur={() => createLead(stage.id)}
                    placeholder="Lead name…"
                    className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none" style={{ borderColor: "var(--gold)" }}
                  />
                ) : (
                  <button onClick={() => { setAdding(stage.id); setNewName(""); }} className="w-full rounded-md border border-dashed px-3 py-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" style={{ borderColor: "var(--border)" }}>+ Lead</button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Drawer */}
      {drawerId && detail && (
        <LeadDrawer
          detail={detail} stages={stages} tz={tz} usingSample={usingSample}
          onClose={() => setDrawerId(null)}
          onAction={action}
          onLocalDetail={setDetail}
          onLogCall={logCall}
        />
      )}
    </div>
  );
}

// ── Lead detail drawer ──────────────────────────────────────────────────────────
function LeadDrawer({
  detail, stages, tz, usingSample, onClose, onAction, onLocalDetail, onLogCall,
}: {
  detail: { lead: Lead; notes: LeadNote[]; tasks: LeadTask[] };
  stages: PipelineStage[];
  tz: string;
  usingSample: boolean;
  onClose: () => void;
  onAction: (kind: string, body: Record<string, unknown>) => Promise<any>;
  onLocalDetail: (d: any) => void;
  onLogCall: (leadId: string, transcript: string) => Promise<{ summary: string; taskCount: number } | null>;
}) {
  const { lead, notes, tasks } = detail;
  const [desc, setDesc] = useState(lead.description ?? "");
  const [ns, setNs] = useState(lead.netsuite_url ?? "");
  const [noteText, setNoteText] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState("");
  const [taskBlock, setTaskBlock] = useState(false); // false = reminder, true = time block

  // log-a-call debrief
  const [callOpen, setCallOpen] = useState(false);
  const [callText, setCallText] = useState("");
  const [callBusy, setCallBusy] = useState(false);
  const [callListening, setCallListening] = useState(false);
  const [expanded, setExpanded] = useState(false); // narrow sidebar ↔ near-fullscreen
  const callRecogRef = useRef<any>(null);
  const callSilenceRef = useRef<any>(null);
  function toggleCallVoice() {
    if (callListening) { clearTimeout(callSilenceRef.current); callRecogRef.current?.stop(); return; }
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!SR) { alert("Speech recognition isn't available here (Brave blocks it). Use Chrome/Edge, or just type the debrief."); return; }
    const r = new SR(); r.lang = "en-US"; r.interimResults = true; r.continuous = true;
    const base = callText ? callText + " " : "";
    const arm = () => { clearTimeout(callSilenceRef.current); callSilenceRef.current = setTimeout(() => { try { r.stop(); } catch { /* */ } }, 4000); };
    r.onresult = (e: any) => { let t = ""; for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript; setCallText(base + t); arm(); };
    r.onerror = () => { clearTimeout(callSilenceRef.current); setCallListening(false); };
    r.onend = () => { clearTimeout(callSilenceRef.current); setCallListening(false); };
    callRecogRef.current = r; setCallListening(true);
    try { r.start(); arm(); } catch { setCallListening(false); }
  }
  async function fileCall() {
    const t = callText.trim(); if (!t || callBusy) return;
    setCallBusy(true);
    const res = await onLogCall(lead.id, t);
    setCallBusy(false);
    if (res) { setCallText(""); setCallOpen(false); }
  }

  useEffect(() => { setDesc(lead.description ?? ""); setNs(lead.netsuite_url ?? ""); }, [lead.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveLead = (patch: Record<string, unknown>) => { if (!usingSample) onAction("update_lead", { id: lead.id, patch }); };
  const addNote = async () => {
    const body = noteText.trim(); if (!body) return; setNoteText("");
    if (usingSample) { onLocalDetail({ ...detail, notes: [{ id: `tmp-${Date.now()}`, lead_id: lead.id, body, author: "manual", created_at: new Date().toISOString() }, ...notes] }); return; }
    await onAction("add_note", { lead_id: lead.id, body });
  };
  const addTask = async () => {
    const title = taskTitle.trim(); if (!title) return; setTaskTitle(""); const due = taskDue; setTaskDue(""); const block = taskBlock; setTaskBlock(false);
    if (usingSample) { onLocalDetail({ ...detail, tasks: [...tasks, { id: `tmp-${Date.now()}`, lead_id: lead.id, title, notes: null, due_at: due ? new Date(due).toISOString() : null, remind_at: null, block_time: block, status: "open", mission_id: null, created_at: new Date().toISOString(), completed_at: null }] }); return; }
    await onAction("add_task", { lead_id: lead.id, title, local_due: due || null, block_time: block });
  };
  const toggleTask = (t: LeadTask) => { if (usingSample) { onLocalDetail({ ...detail, tasks: tasks.map((x) => (x.id === t.id ? { ...x, status: x.status === "done" ? "open" : "done" } : x)) }); return; } onAction("complete_task", { id: t.id, done: t.status !== "done" }); };
  const delTask = (t: LeadTask) => { if (usingSample) { onLocalDetail({ ...detail, tasks: tasks.filter((x) => x.id !== t.id) }); return; } onAction("delete_task", { id: t.id }); };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div onClick={(e) => e.stopPropagation()} className={`relative z-10 flex h-full w-full flex-col overflow-y-auto border-l p-5 transition-[max-width] duration-200 ${expanded ? "max-w-5xl" : "max-w-md"}`} style={{ borderColor: "var(--border)", background: "#15100a" }}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="western text-xl" style={{ color: "var(--gold)" }}>{lead.name}</h2>
          <div className="flex items-center gap-2">
            <button onClick={() => setCallOpen((v) => !v)} className="rounded-md border px-2 py-1 text-xs" style={{ borderColor: "var(--border)", color: "var(--gold)" }} title="Dictate a post-call debrief; Stanley files the note + follow-ups">🎙 Log call</button>
            <button onClick={() => setExpanded((v) => !v)} className="rounded-md border px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]" style={{ borderColor: "var(--border)" }} title={expanded ? "Collapse to sidebar" : "Expand to fullscreen"}>{expanded ? "⇥ Collapse" : "⇤ Expand"}</button>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)]">✕</button>
          </div>
        </div>

        {callOpen && (
          <div className="mb-4 rounded-md border p-3" style={{ borderColor: "var(--gold)", background: "rgba(201,162,74,0.06)" }}>
            <p className="mb-2 text-[11px] text-[var(--text-muted)]">Talk (or type) what happened — Stanley files a summary note and pulls out any follow-up tasks with dates.</p>
            <textarea value={callText} onChange={(e) => setCallText(e.target.value)} rows={3} placeholder="e.g. Talked to the controller, they want pricing by Friday and a multi-entity demo next week…" className="w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--border)", color: "var(--text)" }} />
            <div className="mt-2 flex items-center gap-2">
              <button onClick={toggleCallVoice} className="rounded-md border px-2 py-1 text-sm" style={{ borderColor: "var(--border)", color: callListening ? "var(--blood)" : "var(--text-muted)" }}>{callListening ? "⏹ Stop" : "🎙️ Dictate"}</button>
              <button onClick={fileCall} disabled={callBusy || !callText.trim()} className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">{callBusy ? "Filing…" : "File it"}</button>
            </div>
          </div>
        )}

        {/* Stage */}
        <label className="mb-3 block text-xs text-[var(--text-muted)]">
          Stage
          <select
            value={lead.stage_id ?? ""} onChange={(e) => { if (!usingSample) onAction("move_lead_stage", { id: lead.id, stage_id: e.target.value }); }}
            className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm" style={{ borderColor: "var(--border)", color: "var(--text)" }}
          >
            {stages.map((s) => <option key={s.id} value={s.id} style={{ background: "#15100a" }}>{s.name}</option>)}
          </select>
        </label>

        {/* Description */}
        <label className="mb-3 block text-xs text-[var(--text-muted)]">
          What they do
          <textarea
            value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => saveLead({ description: desc })}
            rows={3} placeholder="Type what they do…"
            className="mt-1 w-full resize-none rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--border)", color: "var(--text)" }}
          />
        </label>

        {/* NetSuite link */}
        <label className="mb-4 block text-xs text-[var(--text-muted)]">
          NetSuite lead record
          <input
            value={ns} onChange={(e) => setNs(e.target.value)} onBlur={() => saveLead({ netsuite_url: ns })}
            placeholder="https://…" className="mt-1 w-full rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--border)", color: "var(--text)" }}
          />
        </label>

        {/* Tasks */}
        <div className="mb-4">
          <p className="western mb-2 text-sm" style={{ color: "var(--gold)" }}>Tasks</p>
          <div className="space-y-1.5">
            {tasks.map((t) => (
              <div key={t.id} className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
                <button onClick={() => toggleTask(t)} className="shrink-0" title="Toggle done" style={{ color: t.status === "done" ? "var(--tier-a)" : "var(--text-muted)" }}>{t.status === "done" ? "✓" : "○"}</button>
                <span className="flex-1" style={{ color: t.status === "done" ? "var(--text-muted)" : "var(--text)", textDecoration: t.status === "done" ? "line-through" : "none" }}>{t.title}</span>
                {t.due_at && <span className="text-[11px]" style={{ color: "var(--gold)" }} title={t.mission_id ? (t.block_time ? "Time-blocked on your calendar" : "Reminder on your calendar") : ""}>{fmtDayTime(t.due_at, tz)}{t.mission_id ? (t.block_time ? " 📅" : " 🔔") : ""}</span>}
                <button onClick={() => delTask(t)} className="text-[var(--text-muted)] hover:text-[var(--blood)]" title="Delete">✕</button>
              </div>
            ))}
            {tasks.length === 0 && <p className="text-xs text-[var(--text-muted)]">No tasks yet.</p>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addTask()} placeholder="New task…" className="flex-1 rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--border)" }} />
            <input type="datetime-local" value={taskDue} onChange={(e) => setTaskDue(e.target.value)} className="rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }} title="Due date adds a calendar item" />
            <button onClick={addTask} className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white">Add</button>
          </div>
          {taskDue && (
            <div className="mt-1.5 flex items-center gap-2 text-[11px]">
              <span className="text-[var(--text-muted)]">On the calendar as:</span>
              <button onClick={() => setTaskBlock(false)} className="rounded-full border px-2 py-0.5" style={{ borderColor: taskBlock ? "var(--border)" : "var(--gold)", color: taskBlock ? "var(--text-muted)" : "var(--gold)" }}>🔔 Reminder</button>
              <button onClick={() => setTaskBlock(true)} className="rounded-full border px-2 py-0.5" style={{ borderColor: taskBlock ? "var(--gold)" : "var(--border)", color: taskBlock ? "var(--gold)" : "var(--text-muted)" }}>📅 Time block</button>
            </div>
          )}
        </div>

        {/* Activity log */}
        <div>
          <p className="western mb-2 text-sm" style={{ color: "var(--gold)" }}>Activity</p>
          <div className="mb-2 flex gap-2">
            <input value={noteText} onChange={(e) => setNoteText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addNote()} placeholder="Log what happened…" className="flex-1 rounded-md border bg-transparent px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--border)" }} />
            <button onClick={addNote} className="rounded-md border px-3 py-1.5 text-xs" style={{ borderColor: "var(--border)" }}>Log</button>
          </div>
          <div className="space-y-2">
            {notes.map((n) => (
              <div key={n.id} className="rounded-md border px-2 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
                <div style={{ color: "var(--text)" }}>{n.body}</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">{fmtDayTime(n.created_at, tz)}{n.author === "chatbot" ? " · Stanley" : ""}</div>
              </div>
            ))}
            {notes.length === 0 && <p className="text-xs text-[var(--text-muted)]">No activity logged yet.</p>}
          </div>
        </div>
      </div>
    </div>
  );
}
