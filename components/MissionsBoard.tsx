"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { Mission } from "@/lib/missions/types";
import { planDay, type PlanBlock } from "@/lib/missions/schedule";

type PlanItem = { action: { name: string; input: any }; describe: string };
type ChatMsg = { who: "you" | "stanley"; text: string };

/* ── time helpers (timezone-aware) ─────────────────────────────────────────── */
const fmtDateBig = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric" }).format(new Date());
const fmtClock = (tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date());
const fmtTime = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
const fmtDay = (iso: string, tz: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(new Date(iso));
const dayKey = (d: Date, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

type Bucket = "overdue" | "today" | "week" | "later" | "someday";
function bucketOf(m: Mission, tz: string): Bucket {
  if (!m.due_at) return "someday";
  const due = new Date(m.due_at);
  const now = new Date();
  if (dayKey(due, tz) === dayKey(now, tz)) return due < now ? "overdue" : "today";
  if (due < now) return "overdue";
  if (due.getTime() - now.getTime() < 7 * 86_400_000) return "week";
  return "later";
}

const PRIORITY_COLOR: Record<string, string> = { high: "var(--blood)", medium: "var(--gold)", low: "var(--text-muted)" };

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.ok ? res.json() : null;
}

export default function MissionsBoard({
  initial,
  usingSample,
  timezone,
  workHours,
  busy,
}: {
  initial: Mission[];
  usingSample: boolean;
  timezone: string;
  workHours: Record<string, { start: string; end: string }>;
  busy: { start: string; end: string }[];
}) {
  const [missions, setMissions] = useState<Mission[]>(initial);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [capture, setCapture] = useState("");
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const historyRef = useRef<any[]>([]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<"day" | "week" | "month">("day");
  const [focus, setFocus] = useState<Date>(() => new Date());

  // Live clock
  const [clock, setClock] = useState(() => fmtClock(timezone));
  useEffect(() => {
    const t = setInterval(() => setClock(fmtClock(timezone)), 1000);
    return () => clearInterval(t);
  }, [timezone]);
  // keep the chat scrolled to the newest line
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, pending]);

  const active = useMemo(
    () => missions.filter((m) => m.status === "open" || m.status === "snoozed").sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9")),
    [missions],
  );
  const grouped = useMemo(() => {
    const g: Record<Bucket, Mission[]> = { overdue: [], today: [], week: [], later: [], someday: [] };
    for (const m of active) g[bucketOf(m, timezone)].push(m);
    return g;
  }, [active, timezone]);

  // "Today's jobs" for the poster = overdue + due-today, by time.
  const todaysJobs = useMemo(() => [...grouped.overdue, ...grouped.today], [grouped]);

  // Build a day plan for ANY date: fit that day's flexible tasks into the work-day
  // gaps around the Outlook busy blocks. (Assumes the browser is in the user's tz.)
  const planFor = useMemo(() => {
    const dk = (d: Date) => dayKey(d, timezone);
    const now = new Date();
    return (d: Date) => {
      const wd = d.getDay() === 0 ? "7" : String(d.getDay());
      const wh = workHours[wd] ?? { start: "08:00", end: "17:00" };
      const dayAt = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const x = new Date(d); x.setHours(h, m, 0, 0); return x.getTime(); };
      const isToday = dk(d) === dk(now);
      const busyOn = busy.filter((b) => dk(new Date(b.start)) === dk(d));
      const rel = active.filter((m) => {
        const dueOn = !!m.due_at && dk(new Date(m.due_at)) === dk(d);
        const schedOn = !!m.scheduled_start && dk(new Date(m.scheduled_start)) === dk(d);
        const overdueToday = isToday && !!m.due_at && new Date(m.due_at) < now && dk(new Date(m.due_at)) !== dk(d);
        return dueOn || schedOn || overdueToday;
      });
      const norm = rel.map((m) => (m.scheduled_start && dk(new Date(m.scheduled_start)) === dk(d) ? m : { ...m, scheduled_start: null, scheduled_end: null }));
      return planDay({ workStart: dayAt(wh.start), workEnd: dayAt(wh.end), busy: busyOn, missions: norm });
    };
  }, [active, busy, workHours, timezone]);

  const weekDays = useMemo(() => {
    const start = new Date(focus); start.setDate(focus.getDate() - ((focus.getDay() + 6) % 7)); // Monday
    return Array.from({ length: 7 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [focus]);
  const monthDays = useMemo(() => {
    const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7)); // grid starts Monday
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
  }, [focus]);
  const shiftFocus = (dir: number) => setFocus((f) => { const d = new Date(f); if (view === "day") d.setDate(f.getDate() + dir); else if (view === "week") d.setDate(f.getDate() + dir * 7); else d.setMonth(f.getMonth() + dir); return d; });

  function applyResult(r: { mission?: Mission; requeued?: boolean } | null, id: string, removedStatuses: string[]) {
    if (!r) return;
    setMissions((prev) => {
      if (r.requeued && r.mission) return prev.map((m) => (m.id === id ? r.mission! : m));
      if (r.mission) return prev.map((m) => (m.id === id ? r.mission! : m));
      return prev.map((m) => (m.id === id ? { ...m, status: removedStatuses[0] as Mission["status"] } : m));
    });
  }

  async function act(id: string, action: "done" | "dismiss" | "snooze", minutes?: number) {
    // optimistic: done/dismiss leave the active list unless they re-queue
    const prev = missions;
    if (action !== "snooze") {
      setMissions((p) => p.map((m) => (m.id === id ? { ...m, status: action === "done" ? "done" : "dismissed" } : m)));
    }
    const r = (await post("/api/missions/action", { id, action, minutes })) as { mission?: Mission; requeued?: boolean } | null;
    if (!r) {
      setMissions(prev); // revert on failure
      return;
    }
    if (r.requeued && r.mission) setMissions((p) => p.map((m) => (m.id === id ? r.mission! : m)));
    else if (r.mission) setMissions((p) => p.map((m) => (m.id === id ? r.mission! : m)));
  }

  // Talk to the Stanley agent. Most actions apply immediately; only deletes come
  // back as a plan to confirm.
  async function sendStanley(text: string) {
    const t = text.trim();
    if (!t || pending) return;
    setChat((c) => [...c, { who: "you", text: t }]);
    setCapture("");
    setPlan([]);
    setPending(true);
    const nextHistory = [...historyRef.current, { role: "user", content: t }];
    const r = (await post("/api/missions/agent", { messages: nextHistory })) as { reply?: string; plan?: PlanItem[]; messages?: any[]; missions?: Mission[] } | null;
    setPending(false);
    if (!r) { setChat((c) => [...c, { who: "stanley", text: "Something went wrong — try again." }]); return; }
    historyRef.current = r.messages ?? nextHistory;
    if (r.missions) setMissions(r.missions); // a write applied → refresh the board
    if (r.reply) setChat((c) => [...c, { who: "stanley", text: r.reply! }]);
    setPlan(r.plan ?? []);
  }
  const sendCapture = () => sendStanley(capture);

  async function confirmPlan() {
    if (plan.length === 0 || pending) return;
    setPending(true);
    const r = (await post("/api/missions/agent/apply", { actions: plan.map((p) => p.action) })) as { results?: string[]; missions?: Mission[] } | null;
    setPending(false);
    if (r?.missions) setMissions(r.missions);
    setChat((c) => [...c, { who: "stanley", text: r?.results?.length ? `✓ ${r.results.join(" · ")}` : "Done." }]);
    historyRef.current = [...historyRef.current, { role: "user", content: `(Applied: ${plan.map((p) => p.describe).join("; ")})` }];
    setPlan([]);
  }

  // Voice (Web Speech API — works in Edge/Chrome; Brave disables it, see message).
  const [listening, setListening] = useState(false);
  const recogRef = useRef<any>(null);
  const transcriptRef = useRef("");
  const silenceRef = useRef<any>(null);
  const SILENCE_MS = 4000; // grace period after you stop talking before it stops listening
  function toggleVoice() {
    if (listening) { clearTimeout(silenceRef.current); recogRef.current?.stop(); return; }
    const SR = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!SR) {
      alert("This browser's speech recognition isn't available — Brave turns it off by default. I can add server-side transcription so voice works in Brave + Edge; just say the word.");
      return;
    }
    const r = new SR();
    r.lang = "en-US"; r.interimResults = true; r.continuous = true; r.maxAlternatives = 1;
    transcriptRef.current = "";
    const armSilence = () => { clearTimeout(silenceRef.current); silenceRef.current = setTimeout(() => { try { r.stop(); } catch { /* ignore */ } }, SILENCE_MS); };
    r.onresult = (e: any) => {
      let t = "";
      for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
      transcriptRef.current = t;
      setCapture(t);
      armSilence(); // each bit of speech resets the grace window
    };
    r.onerror = (e: any) => {
      clearTimeout(silenceRef.current);
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") alert("Microphone access is blocked. Allow the mic for this site and try again.");
      else if (e.error === "network") alert("The speech service is unavailable (Brave blocks it). I can add server-side transcription that works everywhere.");
    };
    r.onend = () => { clearTimeout(silenceRef.current); setListening(false); if (transcriptRef.current.trim()) sendStanley(transcriptRef.current); };
    recogRef.current = r;
    setListening(true);
    try { r.start(); armSilence(); } catch { setListening(false); }
  }
  const drawer = missions.find((m) => m.id === drawerId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <Link href="/" className="mb-1 inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]">‹ Main Menu</Link>
          <div className="flex items-center gap-2">
            <h1 className="western text-2xl" style={{ color: "var(--gold)" }}>Stanley · Missions</h1>
            {usingSample && (
              <span className="rounded-full border px-2 py-0.5 text-[10px] font-medium" style={{ borderColor: "var(--tier-b)", color: "var(--tier-b)" }}>SAMPLE DATA</span>
            )}
          </div>
        </div>
        <span className="tabular-nums text-sm text-[var(--gold)]" title="Current time">🕑 {clock}</span>
      </div>

      {/* Stanley bar (chat/voice) */}
      <div className="mb-3 flex items-center gap-2 rounded-md border px-3 py-2" style={{ borderColor: "var(--gold)", background: "rgba(31,22,13,0.86)" }}>
        <span className="western text-lg" style={{ color: "var(--gold)" }}>Stanley</span>
        <input
          value={capture}
          onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendCapture()}
          placeholder="Talk to Stanley…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
        />
        <button onClick={toggleVoice} className="rounded p-1 text-lg" title={listening ? "Stop listening" : "Speak to Stanley"} style={{ color: listening ? "var(--blood)" : "var(--text-muted)" }}>{listening ? "⏹" : "🎙️"}</button>
        <button onClick={sendCapture} disabled={pending} className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">{pending ? "…" : "Send"}</button>
      </div>

      {/* Conversation + confirm-before-apply plan */}
      {(chat.length > 0 || plan.length > 0) && (
        <div className="mb-6 space-y-3">
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
            <div className="rounded-md border px-4 py-3" style={{ borderColor: "var(--gold)", background: "var(--surface-2)" }}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs uppercase tracking-wide text-[var(--text-muted)]">Confirm {plan.length} {plan.length === 1 ? "action" : "actions"}</span>
                <div className="flex gap-2">
                  <button onClick={confirmPlan} disabled={pending} className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-medium text-white">{pending ? "…" : "Confirm all"}</button>
                  <button onClick={() => setPlan([])} className="rounded-md border px-3 py-1 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>Cancel</button>
                </div>
              </div>
              <ul className="space-y-1">
                {plan.map((p, i) => (
                  <li key={i} className="flex items-center justify-between gap-3 rounded border px-3 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
                    <span>{p.describe}</span>
                    <button onClick={() => setPlan((q) => q.filter((_, j) => j !== i))} className="shrink-0 text-xs text-[var(--text-muted)] hover:text-[var(--blood)]" title="Remove">✕</button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Top: calendar (left, day/week/month) + today paper (right) */}
      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="h-fit rounded-md border p-3" style={{ borderColor: "var(--gold)", background: "rgba(31,22,13,0.86)" }}>
          <div className="mb-2 flex items-center justify-between">
            <div className="flex gap-2">
              {(["day", "week", "month"] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} className="western text-sm capitalize" style={{ color: view === v ? "var(--gold)" : "var(--text-muted)", borderBottom: view === v ? "2px solid var(--gold)" : "2px solid transparent" }}>{v}</button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm">
              <button onClick={() => shiftFocus(-1)} className="px-1 text-[var(--text-muted)] hover:text-[var(--text)]">‹</button>
              <button onClick={() => setFocus(new Date())} className="text-[10px] uppercase tracking-wide text-[var(--text-muted)] hover:text-[var(--text)]">Today</button>
              <button onClick={() => shiftFocus(1)} className="px-1 text-[var(--text-muted)] hover:text-[var(--text)]">›</button>
            </div>
          </div>
          {busy.length === 0 && <p className="mb-1 text-[10px] text-[var(--text-muted)]">Outlook feed not connected</p>}
          {view === "day" && <DayCalendar date={focus} plan={planFor(focus)} tz={timezone} onOpen={setDrawerId} />}
          {view === "week" && <WeekView days={weekDays} planFor={planFor} tz={timezone} onOpen={setDrawerId} onPickDay={(d) => { setFocus(d); setView("day"); }} />}
          {view === "month" && <MonthView days={monthDays} month={focus} active={active} busy={busy} tz={timezone} onPickDay={(d) => { setFocus(d); setView("day"); }} />}
        </div>
        <WantedPoster timezone={timezone} clock={clock} jobs={todaysJobs} onOpen={setDrawerId} />
      </div>

      {/* Chronological list */}
      <div className="space-y-5">
        <Group label="Overdue" tone="var(--blood)" items={grouped.overdue} tz={timezone} onOpen={setDrawerId} onAct={act} />
        <Group label="Today" tone="var(--gold)" items={grouped.today} tz={timezone} onOpen={setDrawerId} onAct={act} />
        <Group label="This week" tone="var(--text)" items={grouped.week} tz={timezone} onOpen={setDrawerId} onAct={act} />
        <Group label="Later" tone="var(--text-muted)" items={grouped.later} tz={timezone} onOpen={setDrawerId} onAct={act} />
        {grouped.someday.length > 0 && <Group label="No date" tone="var(--text-muted)" items={grouped.someday} tz={timezone} onOpen={setDrawerId} onAct={act} />}
        {active.length === 0 && <p className="py-16 text-center text-sm text-[var(--text-muted)]">No open missions.</p>}
      </div>

      {drawer && <MissionDrawer mission={drawer} tz={timezone} onClose={() => setDrawerId(null)} onAct={act} />}
    </div>
  );
}

/* ── Day calendar — Outlook busy (generic) + tasks fitted into the free time ──── */
function DayCalendar({ date, plan, tz, onOpen }: { date: Date; plan: { blocks: PlanBlock[]; unscheduled: { id: string }[] }; tz: string; onOpen: (id: string) => void }) {
  const fmtT = (ms: number) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  const atDate = (h: number) => { const d = new Date(date); d.setHours(h, 0, 0, 0); return d.getTime(); };
  const starts = plan.blocks.map((b) => b.start);
  const ends = plan.blocks.map((b) => b.end);
  const dispStart = Math.min(atDate(7), ...starts);
  const dispEnd = Math.max(atDate(19), ...ends);
  const PX = 0.62;
  const height = ((dispEnd - dispStart) / 60_000) * PX;
  const y = (ms: number) => ((ms - dispStart) / 60_000) * PX;
  const hours: number[] = [];
  for (let h = Math.ceil(dispStart / 3_600_000) * 3_600_000; h <= dispEnd; h += 3_600_000) hours.push(h);
  const nowMs = Date.now();

  return (
    <div>
      <p className="western mb-2 text-sm" style={{ color: "var(--gold)" }}>{new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "short", day: "numeric" }).format(date)}</p>
      <div className="relative" style={{ height }}>
        {hours.map((h) => (
          <div key={h} className="absolute left-0 right-0 flex items-center" style={{ top: y(h) }}>
            <span className="w-12 shrink-0 text-[10px] text-[var(--text-muted)]">{fmtT(h)}</span>
            <div className="ml-1 flex-1 border-t" style={{ borderColor: "var(--border)" }} />
          </div>
        ))}
        {nowMs >= dispStart && nowMs <= dispEnd && (
          <div className="absolute right-0 z-10 border-t-2" style={{ top: y(nowMs), left: 54, borderColor: "var(--blood)" }} />
        )}
        {plan.blocks.map((b, i) => {
          const h = Math.max(15, ((b.end - b.start) / 60_000) * PX);
          const isTask = b.kind === "task";
          return (
            <div
              key={i}
              onClick={() => b.missionId && onOpen(b.missionId)}
              className={`absolute overflow-hidden rounded px-2 py-0.5 text-[11px] leading-tight ${b.missionId ? "cursor-pointer" : ""}`}
              style={{
                top: y(b.start), height: h, left: 54, right: 6,
                background: isTask ? "rgba(181,83,42,0.32)" : "rgba(140,130,118,0.20)",
                borderLeft: `3px solid ${isTask ? "var(--gold)" : "var(--text-muted)"}`,
                color: isTask ? "var(--text)" : "var(--text-muted)",
              }}
            >
              <span className="font-medium">{isTask ? b.title : "Busy"}</span>
              {h > 27 && <span className="block text-[10px] opacity-70">{fmtT(b.start)}–{fmtT(b.end)}</span>}
            </div>
          );
        })}
      </div>
      {plan.unscheduled.length > 0 && (
        <p className="mt-2 text-[10px]" style={{ color: "var(--tier-b)" }}>{plan.unscheduled.length} didn&apos;t fit in the work day</p>
      )}
    </div>
  );
}

/* ── Week view — 7 compact day columns (busy + fitted tasks), 7am–7pm ──────────── */
function WeekView({ days, planFor, tz, onOpen, onPickDay }: { days: Date[]; planFor: (d: Date) => { blocks: PlanBlock[] }; tz: string; onOpen: (id: string) => void; onPickDay: (d: Date) => void }) {
  const PX = 0.34;
  const startH = 7, endH = 19;
  const height = (endH - startH) * 60 * PX;
  const dayKeyL = (d: Date) => dayKey(d, tz);
  const todayK = dayKeyL(new Date());
  return (
    <div className="flex gap-1" style={{ height: height + 24 }}>
      <div className="w-8 shrink-0 pt-6">
        {Array.from({ length: endH - startH + 1 }, (_, i) => (
          <div key={i} className="text-[9px] text-[var(--text-muted)]" style={{ height: 60 * PX }}>{((startH + i - 1) % 12) + 1}{startH + i < 12 ? "a" : "p"}</div>
        ))}
      </div>
      {days.map((d) => {
        const isToday = dayKeyL(d) === todayK;
        const dStart = new Date(d); dStart.setHours(startH, 0, 0, 0);
        const top = (ms: number) => ((ms - dStart.getTime()) / 60_000) * PX;
        const blocks = planFor(d).blocks;
        return (
          <div key={d.toISOString()} className="relative flex-1">
            <button onClick={() => onPickDay(d)} className="mb-1 block w-full text-center text-[10px]" style={{ color: isToday ? "var(--gold)" : "var(--text-muted)" }}>
              {new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d)} {new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(d)}
            </button>
            <div className="relative rounded" style={{ height, background: isToday ? "rgba(201,162,74,0.06)" : "transparent", border: "1px solid var(--border)" }}>
              {blocks.map((b, i) => {
                const t = Math.max(0, top(b.start));
                const h = Math.max(6, Math.min(height - t, ((b.end - b.start) / 60_000) * PX));
                const isTask = b.kind === "task";
                return (
                  <div key={i} onClick={() => b.missionId && onOpen(b.missionId)} title={isTask ? b.title : "Busy"}
                    className={`absolute overflow-hidden rounded-sm px-1 text-[8px] leading-tight ${b.missionId ? "cursor-pointer" : ""}`}
                    style={{ top: t, height: h, left: 1, right: 1, background: isTask ? "rgba(181,83,42,0.5)" : "rgba(140,130,118,0.3)", color: "var(--text)" }}>
                    {isTask ? b.title : ""}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Month view — grid of days with task counts + a busy dot; click to drill in ── */
function MonthView({ days, month, active, busy, tz, onPickDay }: { days: Date[]; month: Date; active: Mission[]; busy: { start: string; end: string }[]; tz: string; onPickDay: (d: Date) => void }) {
  const dk = (d: Date) => dayKey(d, tz);
  const todayK = dk(new Date());
  const busyDays = useMemo(() => new Set(busy.map((b) => dk(new Date(b.start)))), [busy, tz]);
  const tasksByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of active) { const k = t.due_at ? dk(new Date(t.due_at)) : null; if (k) m.set(k, (m.get(k) ?? 0) + 1); }
    return m;
  }, [active, tz]);
  return (
    <div>
      <p className="western mb-2 text-sm" style={{ color: "var(--gold)" }}>{new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "long", year: "numeric" }).format(month)}</p>
      <div className="grid grid-cols-7 gap-px text-center text-[10px] text-[var(--text-muted)]">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="pb-1">{d}</div>)}
        {days.map((d) => {
          const inMonth = d.getMonth() === month.getMonth();
          const k = dk(d);
          const count = tasksByDay.get(k) ?? 0;
          return (
            <button key={d.toISOString()} onClick={() => onPickDay(d)}
              className="flex h-14 flex-col items-center justify-start rounded border p-1 hover:bg-[var(--surface-2)]"
              style={{ borderColor: k === todayK ? "var(--gold)" : "var(--border)", opacity: inMonth ? 1 : 0.4 }}>
              <span className="text-[11px]" style={{ color: k === todayK ? "var(--gold)" : "var(--text)" }}>{new Intl.DateTimeFormat("en-US", { timeZone: tz, day: "numeric" }).format(d)}</span>
              <div className="mt-0.5 flex items-center gap-1">
                {count > 0 && <span className="rounded px-1 text-[9px]" style={{ background: "rgba(181,83,42,0.4)", color: "var(--text)" }}>{count}</span>}
                {busyDays.has(k) && <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--text-muted)" }} />}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── Today paper — a rusty sheet nailed up; just the date + time, then today's list ── */
function WantedPoster({ timezone, clock, jobs, onOpen }: { timezone: string; clock: string; jobs: Mission[]; onOpen: (id: string) => void }) {
  const now = new Date();
  return (
    <aside className="relative h-fit" style={{ filter: "drop-shadow(0 10px 22px rgba(0,0,0,0.55))" }}>
      {/* nail */}
      <span
        className="absolute left-1/2 top-0 z-10 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ background: "radial-gradient(circle at 35% 30%, #d8d2c6, #7d7568 55%, #2b2620)", boxShadow: "0 2px 4px rgba(0,0,0,0.7), inset 0 -1px 1px rgba(0,0,0,0.5)" }}
      />
      <div
        className="px-5 pb-5 pt-7 text-center"
        style={{
          // aged / rusty parchment
          background:
            "radial-gradient(circle at 18% 12%, rgba(120,72,30,0.30), transparent 38%)," +
            "radial-gradient(circle at 85% 88%, rgba(86,44,16,0.34), transparent 44%)," +
            "radial-gradient(circle at 60% 40%, rgba(60,34,14,0.16), transparent 70%)," +
            "linear-gradient(160deg, #cdb488 0%, #bd9f6e 55%, #a07f52 100%)",
          color: "#2c1a0b",
          borderRadius: "3px",
          boxShadow: "inset 0 0 36px rgba(60,34,14,0.45), inset 0 0 0 1px rgba(60,34,14,0.35)",
          clipPath:
            "polygon(0% 1%, 6% 0%, 30% 1.5%, 55% 0%, 80% 1.5%, 96% 0%, 100% 2%, 99% 30%, 100% 60%, 99% 99%, 70% 100%, 40% 99%, 12% 100%, 1% 99%, 0.5% 60%, 1% 30%)",
        }}
      >
        <p className="western text-2xl leading-tight" style={{ color: "#3a2412" }}>{fmtDateBig(timezone)}</p>
        <p className="western tabular-nums text-5xl leading-none" style={{ color: "#241405" }}>{clock}</p>
        <div className="my-3 h-px" style={{ background: "rgba(60,34,14,0.4)" }} />
        <ul className="space-y-1.5 text-left">
          {jobs.map((m) => {
            const overdue = m.due_at ? new Date(m.due_at) < now : false;
            return (
              <li key={m.id}>
                <button onClick={() => onOpen(m.id)} className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-[rgba(60,34,14,0.12)]">
                  <span className="tabular-nums text-xs font-bold" style={{ color: overdue ? "#7a1414" : "#5a3a12", minWidth: 58 }}>
                    {m.due_at ? fmtTime(m.due_at, timezone) : "—"}
                  </span>
                  <span className="text-sm font-medium leading-tight" style={{ color: "#2c1a0b" }}>{m.title}</span>
                </button>
              </li>
            );
          })}
          {jobs.length === 0 && <li className="px-1 py-2 text-center text-xs" style={{ color: "rgba(44,26,11,0.6)" }}>Nothing due today.</li>}
        </ul>
      </div>
    </aside>
  );
}

/* ── list group + row ──────────────────────────────────────────────────────── */
function Group({
  label, tone, items, tz, onOpen, onAct,
}: {
  label: string; tone: string; items: Mission[]; tz: string;
  onOpen: (id: string) => void; onAct: (id: string, a: "done" | "dismiss" | "snooze", min?: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <h2 className="western mb-1.5 text-sm uppercase tracking-wide" style={{ color: tone }}>{label} <span className="text-[var(--text-muted)]">({items.length})</span></h2>
      <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border)" }}>
        {items.map((m, i) => (
          <MissionRow key={m.id} m={m} tz={tz} top={i === 0} onOpen={onOpen} onAct={onAct} />
        ))}
      </div>
    </div>
  );
}

function MissionRow({
  m, tz, top, onOpen, onAct,
}: {
  m: Mission; tz: string; top: boolean;
  onOpen: (id: string) => void; onAct: (id: string, a: "done" | "dismiss" | "snooze", min?: number) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const tomorrow9 = () => {
    const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
    return Math.max(1, Math.round((d.getTime() - Date.now()) / 60000));
  };
  return (
    <div className={`flex items-center gap-3 px-3 py-2.5 text-sm hover:bg-[var(--surface-2)] ${top ? "" : "border-t"}`} style={{ borderColor: "var(--border)" }}>
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PRIORITY_COLOR[m.priority] }} title={`${m.priority} priority`} />
      <button onClick={() => onOpen(m.id)} className="flex-1 text-left">
        <span className="font-medium" style={{ color: "var(--text)" }}>{m.title}</span>
        {m.is_recurring && <span className="ml-2 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">↻ recurring</span>}
        {m.status === "snoozed" && <span className="ml-2 text-[10px] uppercase tracking-wide text-[var(--tier-b)]">snoozed</span>}
      </button>
      <span className="tabular-nums whitespace-nowrap text-xs text-[var(--text-muted)]">
        {m.due_at ? `${fmtDay(m.due_at, tz)} · ${fmtTime(m.due_at, tz)}` : "no date"}
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onAct(m.id, "done")} title="Done" className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--tier-a)", color: "var(--tier-a)" }}>✓</button>
        <div className="relative">
          <button onClick={() => setSnoozeOpen((v) => !v)} title="Snooze" className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>⏰</button>
          {snoozeOpen && (
            <div className="absolute right-0 top-7 z-10 w-32 rounded-md border bg-[var(--surface)] p-1 text-xs shadow-lg" style={{ borderColor: "var(--border)" }}>
              {[["10 min", 10], ["1 hour", 60], ["Tonight", -1], ["Tomorrow 9am", -2]].map(([lbl, v]) => (
                <button key={lbl as string} onClick={() => { const min = v === -1 ? 180 : v === -2 ? tomorrow9() : (v as number); onAct(m.id, "snooze", min); setSnoozeOpen(false); }} className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--surface-2)]">{lbl as string}</button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => onAct(m.id, "dismiss")} title="Dismiss" className="rounded border px-2 py-0.5 text-xs" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>✕</button>
      </div>
    </div>
  );
}

/* ── detail drawer ─────────────────────────────────────────────────────────── */
function MissionDrawer({
  mission, tz, onClose, onAct,
}: {
  mission: Mission; tz: string; onClose: () => void;
  onAct: (id: string, a: "done" | "dismiss" | "snooze", min?: number) => void;
}) {
  return (
    <div className="fixed inset-0 z-20 flex justify-end bg-black/40" onClick={onClose}>
      <div className="h-full w-[420px] overflow-y-auto border-l bg-[var(--surface)] p-5" style={{ borderColor: "var(--border)" }} onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between">
          <h2 className="text-lg font-semibold">{mission.title}</h2>
          <button onClick={onClose} className="text-[var(--text-muted)]">✕</button>
        </div>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <span className="rounded-full border px-2 py-0.5" style={{ borderColor: PRIORITY_COLOR[mission.priority], color: PRIORITY_COLOR[mission.priority] }}>{mission.priority}</span>
          <span className="rounded-full border px-2 py-0.5 capitalize text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{mission.kind}</span>
          {mission.is_recurring && <span className="rounded-full border px-2 py-0.5 text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>↻ recurring</span>}
          <span className="rounded-full border px-2 py-0.5 capitalize text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{mission.status}</span>
        </div>
        <dl className="space-y-2 text-sm">
          {mission.due_at && <Row label="Due">{fmtDay(mission.due_at, tz)} · {fmtTime(mission.due_at, tz)}</Row>}
          {mission.scheduled_start && (
            <Row label="Blocked">{fmtDay(mission.scheduled_start, tz)} · {fmtTime(mission.scheduled_start, tz)}{mission.scheduled_end ? `–${fmtTime(mission.scheduled_end, tz)}` : ""}</Row>
          )}
          {mission.invite_sent_at && <Row label="Invite">sent {fmtDay(mission.invite_sent_at, tz)}</Row>}
          {mission.notes && <Row label="Notes">{mission.notes}</Row>}
        </dl>
        <div className="mt-5 flex gap-2">
          <button onClick={() => { onAct(mission.id, "done"); onClose(); }} className="rounded-md border px-3 py-1.5 text-sm" style={{ borderColor: "var(--tier-a)", color: "var(--tier-a)" }}>✓ Done</button>
          <button onClick={() => { onAct(mission.id, "dismiss"); onClose(); }} className="rounded-md border px-3 py-1.5 text-sm" style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}>Dismiss</button>
        </div>
      </div>
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-xs uppercase tracking-wide text-[var(--text-muted)]">{label}</dt>
      <dd className="flex-1 text-[var(--text)]">{children}</dd>
    </div>
  );
}
