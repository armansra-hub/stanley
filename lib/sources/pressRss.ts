import "server-only";
import Parser from "rss-parser";
import { PRESS_RELEASE_FEEDS, PRESS_KEYWORDS } from "@/config/news";
import type { Candidate } from "@/lib/ingest/types";

/**
 * Press-release RSS adapter (FREE) — Business Wire / GlobeNewswire / PR Newswire.
 * These are firehoses (all industries), so we KEYWORD-PREFILTER each headline
 * (acquisitions, fundings, expansions, finance-leader hires) before spending an
 * AI call. Name-only (the AI extracts the company from the headline). Source-
 * isolated: a failing feed never aborts the run.
 */
const parser = new Parser({ timeout: 12000 });

export async function fetchPressReleaseCandidates(perFeed = 6): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const feed of PRESS_RELEASE_FEEDS) {
    if (!feed.enabled || !feed.url) continue;
    try {
      const parsed = await parser.parseURL(feed.url);
      let kept = 0;
      for (const item of parsed.items ?? []) {
        if (kept >= perFeed) break;
        const title = (item.title ?? "").trim();
        const link = (item.link ?? "").trim();
        if (!title || !link) continue;
        const hay = title.toLowerCase();
        if (!PRESS_KEYWORDS.some((k) => hay.includes(k))) continue; // prefilter the firehose
        out.push({
          name: title,
          source: "discovered",
          sources: ["press_release"],
          signals: [{ source_name: feed.name, source_url: link, raw_excerpt: title }],
        });
        kept++;
      }
    } catch {
      // isolated: skip this feed on error
    }
  }
  return out;
}
