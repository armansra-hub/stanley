/**
 * Claiming Comments — the last column of every lead CSV export.
 *
 * Arman's codex agent takes the exported CSV and claims each lead in NetSuite;
 * this cell becomes the claiming comment verbatim. Rules (his spec):
 *  - 1-4 bullets MAX, one bullet per reason, never restate a reason twice
 *  - each bullet is a terse phrase ("New finance hire"), not a BANT explanation
 *  - derived deterministically from the record — no model calls at export time
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

// Competitor is only meaningful right after a lost-verb — matching it anywhere
// grabs the INCUMBENT system instead of the one they chose (e.g. "on Sage Intacct
// ... went with Rillet" must yield Rillet).
const LOST_TO =
  /(?:lost to|went with|switched to|chose|signed with|moved (?:them )?(?:on)?to|implemented)[^.;]{0,45}?(acumatica|yardi|rillet|sage intacct|intacct|perfectlaw|wellsky|coyote analytics|filevine|deltech|epicor|dynamics(?: sl| gp)?|odoo|xero|quickbooks|qb\b)/i;

function blob(c: any): string {
  return [c.record_digest, ...(Array.isArray(c.oldgold_reasons) ? c.oldgold_reasons : []), c.qual_note]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function sqlWhen(c: any): string {
  const d = String(c.last_sql_date ?? "");
  const m = d.match(/^(\d{4})-(\d{2})/);
  return m ? ` ${Number(m[2])}/${m[1]}` : "";
}

/** One terse bullet per distinct reason, strongest first, capped at `max`. */
export function claimingBullets(c: any, max = 4): string[] {
  const t = blob(c);
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    if (s && !out.includes(s) && out.length < max) out.push(s);
  };

  if (c.record_dead) {
    return [`DO NOT CLAIM — dead lead${c.record_dead_reason ? `: ${String(c.record_dead_reason).slice(0, 70)}` : ""}`];
  }
  // Curated bullets (migration 0033, written by the TAL deep-pass) win VERBATIM —
  // hand-tightened specifics beat anything pattern-derived below.
  if (Array.isArray(c.claim_bullets) && c.claim_bullets.length) {
    return c.claim_bullets.slice(0, max).map((b: unknown) => String(b));
  }
  // Live but bottom-graded blocked archetypes (explicit 3PL, CPA-adjacent, etc.)
  if (/blocked lane|blocked-lane|explicit 3pl|hard-block/.test(t)) add("CAUTION — blocked-lane archetype (see digest)");

  // 1. Live engagement / active evaluation (the strongest claim reason)
  if (/(actively evaluating|active (erp |netsuite )?eval|meeting occurred|held (an? )?(meeting|demo)|evaluation plan|ready to (see|evaluate)|live eval|live engagement|scoping call|demo (call|scheduled|follow)|requested (a )?demo)/.test(t))
    add("Active ERP eval — recent meeting/SQL");
  else if (c.oldgold_class === "timing_arrived") add("Timing arrived — live buying signals");

  // 2. Old Gold revival (qual note + a past SQL moment)
  if (c.oldgold_score != null) add(`Old Gold — prior SQL${sqlWhen(c)}, revive`);

  // 3. The freshest trigger, when the row came off the Triggered tab
  const trig = c.top_trigger ?? (Array.isArray(c.triggers) && c.triggers[0]) ?? null;
  if (trig?.summary) add(String(trig.summary).slice(0, 60));
  else if (trig?.type) add(String(trig.type).replaceAll("_", " "));

  // 4. Distinct record hooks, one bullet each
  if (/(hiring|new|newer|incoming)[^.;]{0,28}(controller|cfo|head of finance|director of finance|vp[^.;]{0,6}finance|senior financial officer|finance manager)|finance-build|finance hire/.test(t))
    add("New finance hire");
  if (/(ex-netsuite|ex-ns|prior netsuite|previous(ly)? (netsuite|ns)|netsuite experience|past ns user|used netsuite)/.test(t))
    add("Ex-NetSuite user on staff");
  if (/(multi-entit|multi-office|multi-location|multi-facilit|sister compan|child compan|subsidiar|consolidat|\b\d+ (entities|offices|locations|branches)\b)/.test(t))
    add("Multi-entity / consolidation need");
  if (/(outgrow|angry at (qb|quickbooks)|quickbooks pain|qb pain|leaving quickbooks|off quickbooks|replace quickbooks|desperate[^.;]{0,20}switch)/.test(t))
    add("Outgrowing QuickBooks");
  else if (/(on (qb|quickbooks)|quickbooks desktop|qbo\b)/.test(t)) add("On QuickBooks");
  if (/(homegrown|custom (software|system|built)|as400|dynamics sl|peachtree|accountedge|sage (50|100)\b|legacy system)/.test(t))
    add("Replacing legacy/homegrown system");
  if (/(private equity|pe(-| )backed|lbo|vc(-| )backed|venture|seed round|series [a-e]\b|new funding|recently? (raised|funded)|acquisition|acquired|roll-?up|merger|merged)/.test(t))
    add("Recent funding / M&A");
  if (/(inc 5000|hypergrowth|high growth|fast-growing|\b\d{2,3}% .{0,12}growth|headcount growth|growing)/.test(t)) add("Growing");
  if (c.oldgold_class === "lost_to_competitor" || /lost to|went with|switched to|chose |signed with/.test(t)) {
    const m = t.match(LOST_TO);
    add(m ? `Prior eval lost to ${m[1].replace(/\b\w/g, (ch) => ch.toUpperCase())} — revisit` : "Prior eval lost — revisit");
  }
  if (c.oldgold_class === "contract_clock") add("Competitor contract expiring");
  if (/(intent signal|erp intent|rfp\b|buyer'?s guide|downloaded)/.test(t)) add("ERP intent signal");
  if (/(controller|cfo|director of finance|in-house finance)/.test(t)) add("In-house finance team");
  if (/(stalled|went quiet|gone quiet|unanswered|no response)/.test(t) && c.oldgold_class === "stalled_warm")
    add("Warm past conversation — re-engage");

  // Fallback so the claim is never blank
  if (out.length === 0) {
    const bits = [c.subindustry || c.ns_industry, c.state].filter(Boolean).join(", ");
    add(bits ? `ICP fit — ${bits}` : "ICP fit — territory account");
  }
  return out;
}

/** The CSV cell: "• reason" lines joined by newlines (CSV-quoted downstream). */
export function buildClaimingComments(c: any): string {
  return claimingBullets(c)
    .map((b) => `• ${b}`)
    .join("\n");
}
