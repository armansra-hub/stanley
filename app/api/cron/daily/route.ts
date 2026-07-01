import { NextRequest, NextResponse } from "next/server";
import { logEvent } from "@/lib/db/events";

/**
 * SINGLE daily cron — fans out to all three pipelines in one job. Vercel's Hobby
 * plan only reliably runs a small number of cron jobs, so three separate crons
 * meant the apify-schedule one silently never fired (and the morning Apify batch
 * never landed). One cron stays under the limit; it triggers the others by calling
 * their endpoints (each runs as its own function with its own 60s budget). The
 * three routes still exist for manual ?secret= invocation.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function run(req: NextRequest) {
  const url = new URL(req.url);
  const auth = req.headers.get("authorization");
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : null; // Vercel Cron sends this
  const secret = req.headers.get("x-cron-secret") ?? url.searchParams.get("secret") ?? bearer;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // AUDIT: record that the cron fired BEFORE the fan-out, so a morning glance at the
  // activity log confirms it ran even if the parent later times out mid-collection.
  await logEvent("headhunter", "daily.fired", { summary: "Daily cron fired — fanning out all sweeps", entity_type: "cron" }).catch(() => {});

  const base = process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : url.origin);
  const s = process.env.CRON_SECRET;
  const hit = async (path: string) => {
    try {
      const sep = path.includes("?") ? "&" : "?";
      const r = await fetch(`${base}${path}${sep}secret=${s}`, { headers: { "x-cron-secret": s! } });
      return { path, status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
      return { path, error: e instanceof Error ? e.message : String(e) };
    }
  };

  // Trigger sweep is FREE (Google News RSS + regex/Opus). Each wave is its own 60s
  // serverless invocation. EMPIRICAL: n=500 (and even n=200) TIMES OUT on slow leads
  // that have many candidate headlines (each → an Opus verify), and a timeout commits
  // NOTHING (rotation cursor isn't stamped) so coverage stalls. So waves are kept
  // SMALL (n=200) and numerous — 25 × 200 = 5,000/day → whole ~7.2k claimable TAM in
  // ~1.5 days, recycling via the last_checked_at cursor, NetSuite-TAM first.
  const TRIGGER_WAVES = 25, TRIGGER_N = 200;
  const triggerWaves = Array.from({ length: TRIGGER_WAVES }, (_, k) =>
    hit(`/api/cron/triggers?n=${TRIGGER_N}&offset=${k * TRIGGER_N}`),
  );
  // ATS sweep OFF on this base — probed 2026-06-27: 0/60 of these 10-50-person firms
  // use Greenhouse/Lever/etc, so daily runs were pure waste. Route kept for manual
  // ?n= runs / a future larger-company list. Set ATS_WAVES>0 to re-enable.
  const ATS_WAVES = 0, ATS_N = 120;
  const atsWaves = Array.from({ length: ATS_WAVES }, (_, k) =>
    hit(`/api/cron/ats?n=${ATS_N}&offset=${k * ATS_N}`),
  );
  // Structured signals OFF on this base — probed 2026-06-27: 0/150 claimable firms
  // had a matching federal award or Form D (small private service firms aren't in
  // those datasets). Route kept for manual runs / a future larger-company list.
  // Set SIG_WAVES>0 to re-enable.
  const SIG_WAVES = 0, SIG_N = 150;
  const sigWaves = Array.from({ length: SIG_WAVES }, (_, k) =>
    hit(`/api/cron/signals?n=${SIG_N}&offset=${k * SIG_N}`),
  );
  // FMCSA fleet-growth monitor over the TAM's ~1,900 transportation companies (FREE).
  // Fleet data changes slowly, so a modest daily volume cycles them in ~3 days.
  const FMCSA_WAVES = 4, FMCSA_N = 150;
  const fmcsaWaves = Array.from({ length: FMCSA_WAVES }, (_, k) =>
    hit(`/api/cron/fmcsa?n=${FMCSA_N}&offset=${k * FMCSA_N}`),
  );
  // Website watch (growth phrases + parent-company + newsroom RSS + careers/finance-
  // hire) over the base (FREE). Each company does up to ~6 fetches, so n=30 keeps every
  // wave under the 60s cap (verified; sweeps are also time-boxed + per-company stamped,
  // so nothing is ever lost to a timeout). Split per the AE's priorities:
  //   • 24 claimable waves (720/day) → NetSuite TAM (~7.2k) refreshes every ~10 days
  //   • 12 tail waves (360/day) → ZoomInfo-only monitored leads (~7.6k) every ~3 weeks
  const SITE_N = 30;
  const siteWaves = [
    ...Array.from({ length: 24 }, (_, k) => hit(`/api/cron/website?n=${SITE_N}&offset=${k * SITE_N}`)),
    ...Array.from({ length: 12 }, (_, k) => hit(`/api/cron/website?n=${SITE_N}&offset=${k * SITE_N}&scope=tail`)),
  ];

  // Colorado registry watch (SoS new-entity + UCC financing) — whole CO base (~720,
  // claimable first), 4 waves. New entity = multi-entity signal; UCC-1 = growth loan.
  const sosWaves = Array.from({ length: 4 }, (_, k) => hit(`/api/cron/cosos?n=200&offset=${k * 200}`));

  // Daily priority recompute over all priority>0 leads — drops "ghost" leads whose
  // trigger has fully decayed/been removed (and no headcount), so the Triggered tab
  // stays clean and every surfaced lead always has a live reason.
  const recomputeWave = [hit(`/api/cron/recompute`)];

  // Run them in parallel — each is its own serverless invocation. Discovery (net-new
  // company finding) is RETIRED — the tool now purely MONITORS the AE's TAM: per-
  // company news (triggerWaves) + FMCSA fleet growth (fmcsaWaves).
  // Build the wave list — calling hit() here DISPATCHES every request synchronously, so
  // all sub-invocations are already sent (and run independently) before we await anything.
  const waves = [
    hit("/api/cron/apify-schedule"), // no-op (paid actors off) — kept for manual re-enable
    hit("/api/cron/tal-news"), // DAILY highest-priority news on claimed (TAL) accounts → in-app alerts
    ...triggerWaves, // per-company NEWS over the whole TAM (funding / acquirer M&A / new entity / expansion)
    ...atsWaves, // (off) job boards
    ...sigWaves, // (off) USAspending + EDGAR
    ...fmcsaWaves, // FMCSA fleet growth over TAM carriers
    ...siteWaves, // website-change + parent + newsroom + careers/finance-hire
    ...sosWaves, // CO Secretary-of-State new-subsidiary (multi-entity) signals
    ...recomputeWave, // drop ghost leads (decayed/removed triggers) so Triggered stays clean
  ];
  // Wait up to 50s (under the 60s kill) for waves to settle, then return a CLEAN 200 so
  // Vercel marks the cron healthy — the waves keep running regardless. Per-sweep events
  // + the daily.fired marker above are the real audit; this just summarizes what finished.
  const settled = await Promise.race([
    Promise.allSettled(waves),
    new Promise<null>((r) => setTimeout(() => r(null), 50_000)),
  ]);
  if (settled) {
    const ok = settled.filter((s) => s.status === "fulfilled" && "status" in s.value && s.value.status === 200).length;
    await logEvent("headhunter", "daily.done", { summary: `Daily sweep — ${ok}/${waves.length} waves OK`, entity_type: "cron", meta: { ok, total: waves.length } }).catch(() => {});
    return NextResponse.json({ ran: settled.length, ok });
  }
  return NextResponse.json({ dispatched: waves.length, note: "waves still running past 50s — see per-sweep events" });
}

export async function GET(req: NextRequest) {
  return run(req);
}
export async function POST(req: NextRequest) {
  return run(req);
}
