import type { Mission } from "./types";

/** Sample missions (relative to "now") so /missions renders before the DB has data. */
function at(hour: number, min = 0, dayOffset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, min, 0, 0);
  return d.toISOString();
}

let n = 0;
function mk(p: Partial<Mission> & { title: string }): Mission {
  n += 1;
  return {
    id: `sample-${n}`,
    title: p.title,
    notes: p.notes ?? null,
    kind: p.kind ?? "task",
    priority: p.priority ?? "medium",
    status: p.status ?? "open",
    due_at: p.due_at ?? null,
    scheduled_start: p.scheduled_start ?? null,
    scheduled_end: p.scheduled_end ?? null,
    all_day: p.all_day ?? false,
    is_recurring: p.is_recurring ?? false,
    rrule: p.rrule ?? null,
    linked_company_id: p.linked_company_id ?? null,
    linked_account_id: p.linked_account_id ?? null,
    source: p.source ?? "manual",
    ics_uid: `sample-uid-${n}`,
    ics_sequence: 0,
    invite_sent_at: null,
    reminder_lead_min: null,
    created_at: at(8, 0),
    completed_at: null,
    dismissed_at: null,
  };
}

export const SAMPLE_MISSIONS: Mission[] = [
  mk({ title: "Email Premier Truck Rental — they ghosted", priority: "high", due_at: at(16, 0, -1), notes: "Day-7 touch. Mention the fixed-asset depreciation angle." }),
  mk({ title: "Follow up with Cobalt Accounting (QuickBooks pain)", priority: "high", due_at: at(9, 0), scheduled_start: at(9, 0), scheduled_end: at(9, 15) }),
  mk({ title: "Prospecting block", kind: "task", priority: "medium", due_at: at(9, 30), scheduled_start: at(9, 30), scheduled_end: at(10, 0), is_recurring: true, rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" }),
  mk({ title: "Call RJW Logistics CFO back", kind: "reminder", priority: "high", due_at: at(11, 0) }),
  mk({ title: "Send NetSuite SQL export to ops", priority: "medium", due_at: at(14, 0), scheduled_start: at(14, 0), scheduled_end: at(14, 20) }),
  mk({ title: "Demo prep — Scope3", priority: "medium", due_at: at(15, 30), scheduled_start: at(15, 30), scheduled_end: at(16, 30) }),
  mk({ title: "Review new Sales Nav growth leads", priority: "low", due_at: at(10, 0, 1) }),
  mk({ title: "Weekly pipeline review", priority: "medium", due_at: at(9, 0, 2), is_recurring: true, rrule: "RRULE:FREQ=WEEKLY;BYDAY=FR" }),
];

/** Sample Outlook "busy" blocks for today (used by the calendar demo until the
 * real published-ICS feed is connected). */
export const SAMPLE_BUSY = [
  { start: at(10, 0), end: at(11, 0) },
  { start: at(12, 30), end: at(13, 0) },
  { start: at(15, 0), end: at(16, 0) },
];
