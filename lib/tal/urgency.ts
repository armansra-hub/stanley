/** Live "reach out now" ranking for the Target Accounts tab.
 * TAM remains the calibrated quality grade; this score adds time-sensitive urgency
 * every time the TAL is read and is never persisted. */
export type TalUrgencyInput = {
  tamScore?: number | null; talAlert?: boolean | null; lastSqlDate?: string | null;
  revisitOn?: string | null; recordDead?: boolean | null; text?: string | null;
  triggers?: Array<{ live: number; type: string; signalDate?: string | null; detectedAt?: string | null }>;
};
export type TalUrgency = { score: number; reasons: string[] };
const DAY = 86_400_000;
const ageDays = (value: string | null | undefined, now: Date) => {
  if (!value) return null; const ms = Date.parse(value); return Number.isNaN(ms) ? null : Math.floor((now.getTime() - ms) / DAY);
};
const daysUntil = (value: string | null | undefined, now: Date) => {
  if (!value) return null; const ms = Date.parse(value); return Number.isNaN(ms) ? null : Math.ceil((ms - now.getTime()) / DAY);
};

export function scoreTalUrgency(input: TalUrgencyInput, now = new Date()): TalUrgency {
  if (input.recordDead) return { score: 0, reasons: ["Record marked dead"] };
  const reasons: string[] = [];
  let score = Math.max(0, Math.min(100, input.tamScore ?? 0)) * 0.5;
  if (input.talAlert) { score += 25; reasons.push("New TAL alert"); }
  const strongest = [...(input.triggers ?? [])].sort((a, b) => b.live - a.live)[0];
  if (strongest) {
    score += Math.max(0, Math.min(100, strongest.live)) * 0.3;
    const age = ageDays(strongest.signalDate ?? strongest.detectedAt, now);
    if (age != null && age <= 7) score += 12; else if (age != null && age <= 30) score += 7; else if (age != null && age <= 90) score += 3;
    reasons.push(`Live ${strongest.type.replace(/_/g, " ")} signal`);
  }
  const sqlAge = ageDays(input.lastSqlDate, now);
  if (sqlAge != null && sqlAge >= 0) {
    if (sqlAge <= 30) { score += 18; reasons.push("SQL in the last 30 days"); }
    else if (sqlAge <= 90) { score += 12; reasons.push("SQL in the last 90 days"); }
    else if (sqlAge <= 180) { score += 7; reasons.push("Recent SQL history"); }
  }
  const revisitDays = daysUntil(input.revisitOn, now);
  if (revisitDays != null) {
    if (revisitDays <= 0) { score += 18; reasons.push("Revisit window is due"); }
    else if (revisitDays <= 30) { score += 12; reasons.push("Revisit window within 30 days"); }
    else if (revisitDays <= 90) { score += 5; reasons.push("Upcoming revisit window"); }
  }
  const text = (input.text ?? "").toLowerCase();
  if (/\b(nurture|send tal drop|reach out|follow up)\b/.test(text)) { score += 6; reasons.push("AE follow-up/nurture direction"); }
  if (/\b(new cfo|new controller|finance hire|hiring|quickbooks|funding|acquisition|m&a|growth)\b/.test(text)) { score += 5; reasons.push("Current buying trigger in record"); }
  if ((input.tamScore ?? 0) > 0) reasons.push(`TAM quality ${Math.round(input.tamScore ?? 0)}`);
  return { score: Math.round(Math.max(0, Math.min(100, score))), reasons: reasons.slice(0, 3) };
}
