"use client";

import { useState } from "react";
import Link from "next/link";
import { SUBINDUSTRIES } from "@/config/territory";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Territory {
  subindustries: string[];
  states: string[];
  naics_codes: string[];
  revenue_min: number | null;
  revenue_max: number | null;
  employees_min: number | null;
  employees_max: number | null;
}
interface AppCfg {
  model_bulk: string;
  model_chat: string;
  chunk_size: number;
  sql_url_field: string;
  ns_stage: string;
  ns_sales_rep: string;
  cross_tag_base?: boolean;
  parent_autodismiss?: boolean;
}
interface ActorRow {
  key: string;
  price: string;
  output: string;
  enabled: boolean;
  setup_note: string | null;
}

const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC","PR","GU",
  "BC","AB","SK","MB","ON","QC","NB","NS","PE","NL","YT","NT","NU",
];

async function save(section: string, payload: any) {
  const res = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ section, payload }),
  });
  if (!res.ok) throw new Error((await res.json())?.error ?? "save failed");
}

function SaveBtn({ onSave }: { onSave: () => Promise<void> }) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  return (
    <button
      onClick={async () => {
        setState("saving");
        try {
          await onSave();
          setState("saved");
          setTimeout(() => setState("idle"), 1500);
        } catch {
          setState("error");
        }
      }}
      className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-white"
    >
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved ✓" : state === "error" ? "Error" : "Save"}
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border p-5" style={{ borderColor: "var(--border)" }}>
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{title}</h2>
      {children}
    </section>
  );
}

const inputCls = "rounded-md border bg-[var(--surface-2)] px-2 py-1 text-sm outline-none";

export default function SettingsForm({
  territory,
  app,
  weights,
  actors,
}: {
  territory: Territory;
  app: AppCfg;
  weights: Record<string, number>;
  actors: ActorRow[];
}) {
  // territory state
  const [subs, setSubs] = useState<Set<string>>(new Set(territory.subindustries));
  const [states, setStates] = useState<Set<string>>(new Set(territory.states));
  const [naics, setNaics] = useState((territory.naics_codes ?? []).join(", "));
  const [revMin, setRevMin] = useState(territory.revenue_min ?? "");
  const [revMax, setRevMax] = useState(territory.revenue_max ?? "");
  const [empMin, setEmpMin] = useState(territory.employees_min ?? "");
  const [empMax, setEmpMax] = useState(territory.employees_max ?? "");

  const [w, setW] = useState<Record<string, number>>(weights);
  const [cfg, setCfg] = useState<AppCfg>(app);
  const [actorState, setActorState] = useState<ActorRow[]>(actors);

  const toggle = (set: Set<string>, v: string, fn: (s: Set<string>) => void) => {
    const n = new Set(set);
    n.has(v) ? n.delete(v) : n.add(v);
    fn(n);
  };

  const weightKeys = Object.keys(w).sort();

  return (
    <div className="mx-auto max-w-[900px] px-6 py-6">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Settings</h1>
          <p className="text-sm text-[var(--text-muted)]">Tune territory, scoring, export, and sources.</p>
        </div>
        <Link href="/" className="rounded-md border px-3 py-1.5 text-sm" style={{ borderColor: "var(--border)" }}>
          ← Dashboard
        </Link>
      </div>

      <div className="space-y-5">
        {/* ── Territory ── */}
        <Section title="Territory">
          <p className="mb-1 text-xs text-[var(--text-muted)]">Subindustries (the hard gate)</p>
          <div className="mb-4 flex flex-wrap gap-1.5">
            {SUBINDUSTRIES.map((s) => (
              <label key={s} className="flex items-center gap-1 rounded border px-2 py-1 text-xs" style={{ borderColor: "var(--border)", background: subs.has(s) ? "color-mix(in srgb, var(--accent) 25%, transparent)" : "transparent" }}>
                <input type="checkbox" checked={subs.has(s)} onChange={() => toggle(subs, s, setSubs)} />
                {s}
              </label>
            ))}
          </div>
          <p className="mb-1 text-xs text-[var(--text-muted)]">States (hard-filters Google Maps)</p>
          <div className="mb-4 flex flex-wrap gap-1">
            {ALL_STATES.map((s) => (
              <label key={s} className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]" style={{ borderColor: "var(--border)", background: states.has(s) ? "color-mix(in srgb, var(--accent) 25%, transparent)" : "transparent" }}>
                <input type="checkbox" checked={states.has(s)} onChange={() => toggle(states, s, setStates)} />
                {s}
              </label>
            ))}
          </div>
          <div className="mb-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
            <label className="flex flex-col gap-1">NAICS codes<input className={inputCls} value={naics} onChange={(e) => setNaics(e.target.value)} placeholder="54, 56, 48" /></label>
            <label className="flex flex-col gap-1">Revenue min<input className={inputCls} type="number" value={revMin} onChange={(e) => setRevMin(e.target.value as any)} /></label>
            <label className="flex flex-col gap-1">Revenue max<input className={inputCls} type="number" value={revMax} onChange={(e) => setRevMax(e.target.value as any)} /></label>
            <label className="flex flex-col gap-1">Employees min<input className={inputCls} type="number" value={empMin} onChange={(e) => setEmpMin(e.target.value as any)} /></label>
            <label className="flex flex-col gap-1">Employees max<input className={inputCls} type="number" value={empMax} onChange={(e) => setEmpMax(e.target.value as any)} /></label>
          </div>
          <SaveBtn onSave={() => save("territory", {
            subindustries: [...subs],
            states: [...states],
            naics_codes: naics.split(",").map((x) => x.trim()).filter(Boolean),
            revenue_min: revMin === "" ? null : Number(revMin),
            revenue_max: revMax === "" ? null : Number(revMax),
            employees_min: empMin === "" ? null : Number(empMin),
            employees_max: empMax === "" ? null : Number(empMax),
          })} />
        </Section>

        {/* ── Scoring weights ── */}
        <Section title="Scoring weights (0–100 deterministic score)">
          <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-3">
            {weightKeys.map((k) => (
              <label key={k} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-[var(--text-muted)]">{k}</span>
                <input className={`${inputCls} w-16 text-right`} type="number" value={w[k]} onChange={(e) => setW({ ...w, [k]: Number(e.target.value) })} />
              </label>
            ))}
          </div>
          <SaveBtn onSave={() => save("scoring", { rows: weightKeys.map((k) => { const [signal_type, strength] = k.split(":"); return { signal_type, strength, weight: w[k] }; }) })} />
        </Section>

        {/* ── Export & models ── */}
        <Section title="NetSuite export & models">
          <div className="mb-4 grid grid-cols-2 gap-3 text-xs md:grid-cols-3">
            <label className="flex flex-col gap-1">Stage<input className={inputCls} value={cfg.ns_stage} onChange={(e) => setCfg({ ...cfg, ns_stage: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Sales Rep<input className={inputCls} value={cfg.ns_sales_rep} onChange={(e) => setCfg({ ...cfg, ns_sales_rep: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Chunk size<input className={inputCls} type="number" value={cfg.chunk_size} onChange={(e) => setCfg({ ...cfg, chunk_size: Number(e.target.value) })} /></label>
            <label className="flex flex-col gap-1">URL field token<input className={inputCls} value={cfg.sql_url_field} onChange={(e) => setCfg({ ...cfg, sql_url_field: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Model (bulk)<input className={inputCls} value={cfg.model_bulk} onChange={(e) => setCfg({ ...cfg, model_bulk: e.target.value })} /></label>
            <label className="flex flex-col gap-1">Model (chat)<input className={inputCls} value={cfg.model_chat} onChange={(e) => setCfg({ ...cfg, model_chat: e.target.value })} /></label>
          </div>
          <label className="mb-3 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={cfg.cross_tag_base ?? true} onChange={(e) => setCfg({ ...cfg, cross_tag_base: e.target.checked })} />
            Cross-tag new leads against the TAM base by name (inherit lists, claimable &amp; NetSuite ID)
          </label>
          <label className="mb-3 flex items-center gap-2 text-xs">
            <input type="checkbox" checked={cfg.parent_autodismiss ?? true} onChange={(e) => setCfg({ ...cfg, parent_autodismiss: e.target.checked })} />
            Auto-dismiss high-confidence subsidiaries (&quot;subsidiary of / acquired by X&quot; on their own site). Off = just flag them.
          </label>
          <SaveBtn onSave={() => save("app", cfg)} />
        </Section>

        {/* ── Apify actors ── */}
        <Section title="Apify sources (paid)">
          <div className="space-y-2">
            {actorState.map((a, i) => (
              <div key={a.key} className="flex items-start justify-between gap-3 border-b pb-2 text-sm" style={{ borderColor: "var(--border)" }}>
                <div>
                  <div className="font-medium capitalize">{a.key.replace(/_/g, " ")} <span className="text-[10px] text-[var(--text-muted)]">{a.price}</span></div>
                  <div className="text-[11px] text-[var(--text-muted)]">{a.output}</div>
                  {a.setup_note && <div className="text-[11px] text-[var(--tier-b)]">⚠ {a.setup_note}</div>}
                </div>
                <label className="flex shrink-0 items-center gap-1 text-xs">
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={async (e) => {
                      const enabled = e.target.checked;
                      setActorState((prev) => prev.map((x, j) => (j === i ? { ...x, enabled } : x)));
                      await save("actors", { key: a.key, enabled });
                    }}
                  />
                  {a.enabled ? "on" : "off"}
                </label>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}
