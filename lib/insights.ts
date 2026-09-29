import type { RegistryProfile } from "@/lib/agent/registryProfiles";

/** Read-only findings: standing facts never contribute to trigger priority. */
export interface InsightBadge {
  source?: string | null;
  kind: string;
  label: string;
  detail: string | null;
  evidence: string;
  evidence_url: string | null;
  confidence: string;
  registry_profile?: RegistryProfile | null;
}

export function insightSourceLabel(insight: Pick<InsightBadge, "source" | "evidence_url">): string {
  if (insight.source === "registry") return "Public registry";
  if (insight.source === "linkedin") return "LinkedIn";
  if (insight.source === "website") return "Company website";
  if (insight.source) return insight.source.replace(/_/g, " ");
  try {
    const host = new URL(insight.evidence_url ?? "").hostname.toLowerCase();
    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "LinkedIn";
  } catch { /* A missing source remains unnamed. */ }
  return "Company research";
}

export function insightHeading(insight: InsightBadge): string {
  if (insight.source === "registry") return `Public registry baseline — ${insight.registry_profile?.displayLabel || insight.registry_profile?.dataset.replace(/_/g, " ") || "Stored profile"}`;
  return `${insightSourceLabel(insight)} ${insight.kind === "netsuite_fit" ? "NetSuite fit" : "ops profile"} — ${insight.label}`;
}

export function publicInsightUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null;
  } catch { return null; }
}
