import "server-only";
import type { Candidate } from "@/lib/ingest/types";
import { getTerritoryConfig } from "@/lib/db/companies";
import { getFmcsaSnapshot, upsertFmcsaSnapshot } from "@/lib/db/fmcsa";

/**
 * FMCSA Motor Carrier Census adapter (FREE — Socrata, no key; an optional
 * SOCRATA_APP_TOKEN only raises rate limits). Surfaces authorized for-hire
 * carriers in the territory states with a mid-market fleet (asset/maintenance/
 * depreciation accounting that QuickBooks chokes on). A random offset samples
 * different carriers each run. Where the census has a corporate email, we
 * derive the domain (→ SQL-exportable); otherwise domain=null.
 *
 * NOTE: the census is a snapshot, not a real-time "new authority this week"
 * feed (the date fields are text DD-MON-YY and can't be range-filtered server-
 * side). So this is targeted in-territory carrier DISCOVERY by fleet size, with
 * the MCS-150 date shown as recency context. True new-authority/fleet-growth
 * deltas would need run-over-run snapshot diffing (future enhancement).
 */
const DATASET = "https://data.transportation.gov/resource/kjg3-diqy.json";
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN;

const CANADIAN = new Set(["BC", "AB", "YT", "NT", "NU", "ON", "QC", "MB", "SK", "NS", "NB", "NL", "PE"]);
const FREE_EMAIL = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com", "icloud.com",
  "comcast.net", "att.net", "sbcglobal.net", "msn.com", "live.com", "ymail.com",
  "me.com", "verizon.net", "bellsouth.net", "cox.net",
]);

function domainFromEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const m = email.toLowerCase().trim().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  if (!m) return undefined;
  return FREE_EMAIL.has(m[1]) ? undefined : m[1];
}

export async function fetchFmcsaCandidates(
  opts: { minUnits?: number; maxUnits?: number; limit?: number } = {},
): Promise<Candidate[]> {
  const minUnits = opts.minUnits ?? 20;
  const maxUnits = opts.maxUnits ?? 500;
  const limit = opts.limit ?? 15;

  const { states } = await getTerritoryConfig();
  const us = states.filter((s) => /^[A-Z]{2}$/.test(s) && !CANADIAN.has(s));
  if (us.length === 0) return [];

  const where =
    `phy_state in(${us.map((s) => `'${s}'`).join(",")}) ` +
    `AND authorized_for_hire='true' ` +
    `AND nbr_power_unit::number > ${minUnits} AND nbr_power_unit::number < ${maxUnits}`;

  const params = new URLSearchParams({
    $select: "dot_number,legal_name,dba_name,phy_city,phy_state,nbr_power_unit,driver_total,mcs150_date,email_address",
    $where: where,
    $order: "nbr_power_unit::number DESC",
    $limit: String(limit),
    $offset: String(Math.floor(Math.random() * 300)),
  });

  try {
    const res = await fetch(`${DATASET}?${params}`, {
      headers: APP_TOKEN ? { "X-App-Token": APP_TOKEN } : {},
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows)) return [];

    const out: Candidate[] = [];
    for (const r of rows) {
      const name = String(r.dba_name || r.legal_name || "").trim();
      if (!name) continue;
      const dot = String(r.dot_number ?? "");
      const units = parseInt(String(r.nbr_power_unit ?? ""), 10) || 0;
      const drivers = parseInt(String(r.driver_total ?? ""), 10) || 0;
      const url = dot
        ? `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`
        : "https://safer.fmcsa.dot.gov/CompanySnapshot.aspx";

      // Run-over-run fleet-growth delta. Falls back to baseline firmographic if
      // the snapshot table isn't present yet (see migration 0002).
      let excerpt = `FMCSA census: authorized for-hire motor carrier in ${r.phy_city}, ${r.phy_state} operating ${units} power units and ${drivers} drivers; MCS-150 last filed ${r.mcs150_date}.`;
      if (dot) {
        try {
          const prior = await getFmcsaSnapshot(dot);
          if (prior && prior.nbr_power_unit > 0 && units >= Math.ceil(prior.nbr_power_unit * 1.15)) {
            excerpt = `FMCSA census: fleet GREW from ${prior.nbr_power_unit} to ${units} power units (drivers now ${drivers}) since ${prior.captured_at.slice(0, 10)} — authorized for-hire carrier in ${r.phy_city}, ${r.phy_state}.`;
          }
          await upsertFmcsaSnapshot(dot, name, units, drivers);
        } catch {
          // snapshot table missing → baseline (no delta)
        }
      }

      out.push({
        name,
        website: domainFromEmail(r.email_address),
        state: r.phy_state ?? null,
        city: r.phy_city ?? null,
        source: "discovered",
        sources: ["fmcsa"],
        signals: [{ source_name: "FMCSA Census", source_url: url, raw_excerpt: excerpt }],
      });
    }
    return out;
  } catch {
    return [];
  }
}
