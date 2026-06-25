import type { Company, Signal, ScoreTier } from "@/lib/types";
import { scoreBand } from "@/lib/scoring";

const TIER_COLOR: Record<ScoreTier, string> = {
  A: "var(--tier-a)",
  B: "var(--tier-b)",
  C: "var(--tier-c)",
};

/** Independent LLM tier badge (A/B/C). */
export function TierBadge({ tier }: { tier: ScoreTier | null }) {
  if (!tier) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <span
      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
      style={{ background: TIER_COLOR[tier] }}
      title={`LLM tier ${tier}`}
    >
      {tier}
    </span>
  );
}

/** Deterministic 0–100 score badge. */
export function ScoreBadge({ score }: { score: number }) {
  const band = scoreBand(score);
  const color =
    band === "Strong" ? "var(--tier-a)" : band === "Medium" ? "var(--tier-b)" : "var(--tier-c)";
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold"
      style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}
      title={`${band} (${score}/100)`}
    >
      {score}
      <span className="opacity-70">{band}</span>
    </span>
  );
}

export function SignalChips({ signals }: { signals: Signal[] }) {
  const types = Array.from(new Set(signals.map((s) => s.type)));
  return (
    <div className="flex flex-wrap gap-1">
      {types.map((t) => (
        <span
          key={t}
          className="rounded border px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
          style={{ borderColor: "var(--border)" }}
        >
          {t.replace(/_/g, " ")}
        </span>
      ))}
    </div>
  );
}

/** Friendly labels for the adapter/source ids stored on company.sources. */
export const SOURCE_LABELS: Record<string, string> = {
  google_maps: "Google Maps",
  indeed: "Indeed",
  google_jobs: "Google Jobs",
  linkedin_jobs: "LinkedIn Jobs",
  career_sites: "Career Sites",
  linkedin_posts: "LinkedIn Posts",
  leads_finder: "Leads Finder",
  sales_nav: "Sales Navigator",
  sales_nav_growth: "Sales Nav (Growth)",
  builtin_jobs: "BuiltIn",
  google_news: "Google News",
  press_release: "Press Release",
  edgar_form_d: "SEC Form D",
  fmcsa: "FMCSA",
  usaspending: "USASpending",
  imported: "Imported",
  inc5000: "Inc. 5000",
};

export function sourceLabel(id: string): string {
  return SOURCE_LABELS[id] ?? id.replace(/_/g, " ");
}

/** Which actor(s) found this lead — for performance tracking. */
export function SourceBadge({ sources }: { sources: string[] }) {
  if (!sources || sources.length === 0) return <span className="text-[var(--text-muted)]">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {sources.map((s) => (
        <span
          key={s}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{ background: "color-mix(in srgb, var(--gold) 16%, transparent)", color: "var(--gold)" }}
          title={`Found by ${sourceLabel(s)}`}
        >
          {sourceLabel(s)}
        </span>
      ))}
    </div>
  );
}

/** Strongest signal = highest weight, tie broken toward subindustry-relevant. */
export function strongestSignal(c: Company): Signal | null {
  if (!c.signals.length) return null;
  return [...c.signals].sort(
    (a, b) => b.weight - a.weight || Number(b.subindustry_relevant) - Number(a.subindustry_relevant),
  )[0];
}
