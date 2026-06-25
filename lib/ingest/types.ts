import type { CompanySource } from "@/lib/types";
import type { RawSignalInput } from "@/lib/ai/enrich";

/**
 * A candidate company produced by a source adapter (job scraper, Google Maps,
 * EDGAR, news RSS, FMCSA, USASpending, …) before AI enrichment + scoring.
 * Every signal must carry a real source_url + raw_excerpt (hard rule).
 */
export interface Candidate {
  name: string; // company name, OR a news headline the LLM will extract the company from
  website?: string; // derives the normalized domain (dedupe key); absent for name-only sources
  state?: string | null;
  city?: string | null;
  employee_band?: string | null;
  revenue_band?: string | null;
  source?: CompanySource; // discovered (default) | imported
  sources?: string[]; // which adapters found it (ids from config)
  signals: RawSignalInput[];
}
