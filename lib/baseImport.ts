/**
 * Pure helpers for the TAM Base import — vendor weighting, technographic
 * ERP-readiness, and headcount parsing. No I/O, so they're unit-testable and
 * safe to share between the API route and the DB layer.
 */

export type LeadVendor = "netsuite" | "zoominfo" | "linkedin";

/** Source-confidence weight. NetSuite is the AE's permanent SOURCE OF TRUTH (highest
 * solo weight + wins field conflicts); ZoomInfo + LinkedIn fill in around it (Apollo
 * dropped 2026-06-27). A company seen in MORE than one source is the strongest fit. */
export const VENDOR_WEIGHT: Record<LeadVendor, number> = { netsuite: 1.1, zoominfo: 1.0, linkedin: 1.0 };
export const MULTI_SOURCE_WEIGHT = 1.2;

export function fitWeightFor(vendors: Iterable<string>): number {
  const list = [...vendors].filter((v): v is LeadVendor => v in VENDOR_WEIGHT);
  if (list.length === 0) return 1.0;
  if (list.length > 1) return MULTI_SOURCE_WEIGHT;
  return VENDOR_WEIGHT[list[0]];
}

// QuickBooks-tier stacks = ERP-ready candidates (outgrowing them is the NetSuite pitch).
const QB_TIER = ["quickbooks", "qbo", "quick books", "xero", "bill.com", "sage 50", "sage 100", "freshbooks", "wave accounting"];
// A real ERP already in place → NOT ready (don't chase).
const REAL_ERP = ["netsuite", "sage intacct", "intacct", "acumatica", "dynamics 365", "dynamics gp", "microsoft dynamics", "sap ", "oracle erp", "oracle fusion", "workday"];

/** Split a vendor "technologies" cell into a clean list. */
export function parseTechnologies(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,|]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 60);
}

/** ERP-ready = runs a QB-tier accounting stack AND has no real ERP yet. Unknown
 * (no technographics) → false (we just don't have the signal). */
export function isErpReady(technologies: string[]): boolean {
  const hay = technologies.join(" ").toLowerCase();
  const hasQbTier = QB_TIER.some((t) => hay.includes(t));
  const hasRealErp = REAL_ERP.some((t) => hay.includes(t));
  return hasQbTier && !hasRealErp;
}

/** Pull a headcount integer out of the many shapes vendors use ("51-200", "120",
 * "1,200", "201 - 500 employees"). Returns the LOW end of a range. */
export function parseEmployees(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const nums = raw.replace(/,/g, "").match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return parseInt(nums[0], 10);
}

const BANDS: [number, number, string][] = [
  [1, 19, "1-19"], [20, 49, "20-49"], [50, 199, "50-199"], [200, 499, "200-499"],
  [500, 999, "500-999"], [1000, 4999, "1K-5K"], [5000, Infinity, "5K+"],
];
export function employeeBand(count: number | null): string | null {
  if (count == null) return null;
  for (const [lo, hi, label] of BANDS) if (count >= lo && count <= hi) return label;
  return null;
}
