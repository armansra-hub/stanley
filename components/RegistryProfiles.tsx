import type { RegistryProfile } from "@/lib/agent/registryProfiles";
import { publicInsightUrl, type InsightBadge } from "@/lib/insights";

const COUNT_LABELS: Record<string, string> = {
  nbr_power_unit: "Power units", power_units: "Power units", powerUnits: "Power units",
  driver_total: "Drivers", drivers: "Drivers", driverCount: "Drivers",
  active_participants_boy: "Active plan participants at year start",
  active_participants_eoy: "Active plan participants at year end",
  participants: "Plan participants", trailers: "Trailers",
  jobs_supported: "Jobs supported",
};
const DATASET_LABELS: Record<string, string> = {
  fmcsa: "FMCSA carrier census", irs_exempt: "IRS nonprofit financials", sba_7a: "SBA 7(a) loan approval", sba_504: "SBA 504 loan approval",
  tx_surveying: "Texas surveying firm registration", tx_engineering: "Texas engineering firm registration",
  wa_contractors: "Washington contractor license", ca_contractors: "California contractor license",
  co_sos: "Colorado business registration", co_ucc: "Colorado UCC filing", bc_orgbook: "BC business registration",
  ca_corporations: "Canadian federal corporation", cra_charities: "Canadian charity financials",
  cms_nppes: "Organizational NPI", sec_adv: "Investment adviser registration", sec_edgar: "SEC company filing", inc5000: "Inc. 5000 ranking",
};

function date(value: string | null | undefined): string {
  if (!value) return "Date unavailable";
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value);
  return Number.isFinite(parsed.getTime()) ? parsed.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
}

function factDisplay(fact: RegistryProfile["facts"][number]) {
  const label = COUNT_LABELS[fact.field] ?? fact.label;
  const value = typeof fact.value === "number" ? fact.value.toLocaleString("en-US", { maximumFractionDigits: 8 })
    : typeof fact.value === "boolean" ? fact.value ? "Yes" : "No" : fact.value;
  // The source's count category is authoritative; drivers/participants are not employees.
  return { label, value: `${value}${fact.unit && !COUNT_LABELS[fact.field] ? ` ${fact.unit}` : ""}` };
}

export default function RegistryProfiles({ insights, loaded = true }: { insights: InsightBadge[]; loaded?: boolean }) {
  if (!loaded) return null;
  const rows = insights.filter(insight => insight.source === "registry");
  return <section className="mb-4 rounded-md border p-3 text-sm" style={{ borderColor: "var(--border)" }} aria-label="Public registry baseline">
    <h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">Public registry baseline</h3>
    <p className="mt-1 text-xs text-[var(--text-muted)]">Standing public-record facts. Dates and coverage apply to each source; this is not a claim that every registry has been checked.</p>
    {!rows.length && <p className="mt-2 text-xs text-[var(--text-muted)]">No verified registry profile is stored for this account. Registry coverage remains unknown.</p>}
    <div className="space-y-3">
      {rows.map((insight, index) => {
        const profile = insight.registry_profile;
        if (!profile || profile.version !== 1 || !Array.isArray(profile.facts)) return <p key={index} className="mt-2 text-xs text-[var(--text-muted)]">Stored registry profile details are unavailable.</p>;
        const url = publicInsightUrl(insight.evidence_url);
        return <article className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }} key={`${profile.dataset}:${profile.recordId}`}>
          <h4 className="font-medium">{profile.displayLabel || DATASET_LABELS[profile.dataset] || profile.dataset.replace(/_/g, " ")}</h4>
          {!profile.recordId.startsWith("row-") && <p className="mt-1 text-xs text-[var(--text-muted)]">Record {profile.recordId}</p>}
          <p className="text-xs text-[var(--text-muted)]">Source as of: {date(profile.sourceAsOf)} · Collected: {date(profile.observedAt)}</p>
          {insight.detail && <p className="mt-1 text-xs text-[var(--text-muted)]">{insight.detail}</p>}
          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {profile.facts.map((fact, factIndex) => {
              const display = factDisplay(fact);
              return <div key={`${fact.field}:${factIndex}`} className="contents"><dt className="text-[var(--text-muted)]">{display.label}</dt><dd className="break-words font-medium">{display.value}</dd></div>;
            })}
          </dl>
          {profile.facts.some(fact => COUNT_LABELS[fact.field]) && <p className="mt-2 text-xs text-[var(--text-muted)]">Driver, fleet, plan-participant and jobs-supported counts are source-specific measures, not total employee counts.</p>}
          {url && <a href={url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-[var(--accent)] hover:underline">View public record source ↗</a>}
          <details className="mt-2 text-xs">
            <summary className="cursor-pointer text-[var(--text-muted)]">Matched identity and source evidence</summary>
            <p className="mt-1">{profile.identity?.legalName}</p>
            <p className="text-[var(--text-muted)]">{[profile.identity?.addressLine1, profile.identity?.addressLine2, profile.identity?.city, profile.identity?.state, profile.identity?.postalCode].filter(Boolean).join(", ")}</p>
            <p className="mt-1 text-[var(--text-muted)]">{profile.verification?.method === "prior_registry_binding" ? "Matched through an existing verified registry binding."
              : profile.verification?.method === "exact_legal_name_address" ? "Matched by legal name and business address." : "Identity verification details unavailable."}</p>
            <blockquote className="mt-1 whitespace-pre-wrap border-l-2 pl-2 text-[var(--text-muted)]" style={{ borderColor: "var(--border)" }}>{profile.provenance?.quote || insight.evidence}</blockquote>
          </details>
        </article>;
      })}
    </div>
  </section>;
}
