export type MissionKind = "task" | "reminder";
export type MissionPriority = "low" | "medium" | "high";
export type MissionStatus = "open" | "done" | "dismissed" | "snoozed";
export type MissionSource = "manual" | "voice" | "chat" | "auto" | "pipeline";

export interface Mission {
  id: string;
  title: string;
  notes: string | null;
  kind: MissionKind;
  priority: MissionPriority;
  status: MissionStatus;
  due_at: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  all_day: boolean;
  is_recurring: boolean;
  rrule: string | null;
  linked_company_id: string | null;
  linked_account_id: string | null; // Kill List lead (the Task↔Mission bridge)
  source: MissionSource;
  ics_uid: string;
  ics_sequence: number;
  invite_sent_at: string | null;
  reminder_lead_min: number | null;
  created_at: string;
  completed_at: string | null;
  dismissed_at: string | null;
}

export interface UserPrefs {
  timezone: string;
  work_hours: Record<string, { start: string; end: string }>;
  quiet_hours: { start: string; end: string };
  reminder_lead_min: number;
  from_email: string | null;
  user_email: string | null;
  ics_publish_url: string | null;
}

export interface BusyBlock {
  id: string;
  external_uid: string | null;
  title: string | null;
  start: string;
  end: string;
  busy: boolean;
}
