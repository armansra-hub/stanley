export interface PipelineStage {
  id: string;
  name: string;
  sort_order: number;
  color: string | null;
  archived: boolean;
}

export interface Lead {
  id: string;
  name: string;
  website: string | null;
  description: string | null;
  netsuite_url: string | null;
  stage_id: string | null;
  sort_in_stage: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  // derived (joined for the card) — not columns
  open_tasks?: number;
  next_due_at?: string | null;
}

export interface LeadNote {
  id: string;
  lead_id: string;
  body: string;
  author: "manual" | "chatbot";
  created_at: string;
}

export interface LeadTask {
  id: string;
  lead_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  remind_at: string | null;
  block_time: boolean; // true = time-block (auto-fit around meetings); false = pinned reminder
  status: "open" | "done";
  mission_id: string | null;
  created_at: string;
  completed_at: string | null;
}
