import "server-only";
import Parser from "rss-parser";
import type { Candidate } from "@/lib/ingest/types";

/**
 * SEC EDGAR Form D adapter (FREE, US-only). Pulls the "latest filings" Atom
 * feed and keeps exactly form D / D/A (exempt securities offerings = a capital
 * raise → funding signal). SEC fair-access requires a real email in the
 * User-Agent. Name-only (domain=null). NOTE: Form D skews toward funds/SPVs/
 * startups, so the in-territory hit rate for B2B services/transport is low —
 * the territory gate drops the rest.
 */
const EDGAR_EMAIL = process.env.EDGAR_USER_AGENT_EMAIL || "armansra@gmail.com";
const parser = new Parser({
  timeout: 12000,
  headers: { "User-Agent": `Jarvis-Prospecting ${EDGAR_EMAIL}` },
});

const FEED =
  "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&company=&dateb=&owner=include&count=100&output=atom";

export async function fetchEdgarFormDCandidates(limit = 12): Promise<Candidate[]> {
  try {
    const feed = await parser.parseURL(FEED);
    const out: Candidate[] = [];
    for (const item of feed.items ?? []) {
      const title = (item.title ?? "").trim();
      const sep = title.indexOf(" - ");
      if (sep < 0) continue;
      const formType = title.slice(0, sep).trim();
      if (formType !== "D" && formType !== "D/A") continue; // exactly Form D (not DEF 14A etc.)
      const link = (item.link ?? "").trim();
      if (!link) continue;
      // "D - Company Name (CIK) (Filer)" → "Company Name"
      const name = title
        .slice(sep + 3)
        .replace(/\s*\(\d+\).*$/, "")
        .trim();
      if (!name) continue;
      out.push({
        name,
        source: "discovered",
        sources: ["edgar_form_d"],
        signals: [
          {
            source_name: "SEC EDGAR (Form D)",
            source_url: link,
            raw_excerpt: `Filed an SEC Form D exempt securities offering (${title}).`,
          },
        ],
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}
