import type { PipelineStage, Lead, LeadNote, LeadTask } from "./types";

/* Sample board so /kill-list renders before any real data is entered. The page
 * swaps to live Supabase data the moment a stage or lead exists. */

export const SAMPLE_STAGES: PipelineStage[] = [
  { id: "s-hot", name: "Hot Leads", sort_order: 0, color: "#8c1d1d", archived: false },
  { id: "s-intro", name: "Post Intro", sort_order: 1, color: "#b5532a", archived: false },
  { id: "s-opp", name: "Opportunities", sort_order: 2, color: "#c9a24a", archived: false },
  { id: "s-nurture", name: "Nurture", sort_order: 3, color: "#8a7a63", archived: false },
];

const iso = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

export const SAMPLE_LEADS: Lead[] = [
  { id: "l-1", name: "Ridgeline Logistics", website: "ridgeline.example", description: "Regional 3PL moving to a real ERP after outgrowing QuickBooks.", netsuite_url: null, stage_id: "s-hot", sort_in_stage: 0, last_activity_at: iso(-1), created_at: iso(-12), updated_at: iso(-1), open_tasks: 2, next_due_at: iso(1) },
  { id: "l-2", name: "Copperfield Mfg", website: "copperfield.example", description: "Mid-market manufacturer, multi-entity, CFO wants consolidations.", netsuite_url: null, stage_id: "s-intro", sort_in_stage: 0, last_activity_at: iso(-3), created_at: iso(-20), updated_at: iso(-3), open_tasks: 1, next_due_at: iso(3) },
  { id: "l-3", name: "Atlas Field Services", website: null, description: "Field-service company, lots of techs, current system can't do scheduling.", netsuite_url: null, stage_id: "s-opp", sort_in_stage: 0, last_activity_at: iso(-2), created_at: iso(-30), updated_at: iso(-2), open_tasks: 1, next_due_at: iso(0) },
  { id: "l-4", name: "Harbor Coffee Roasters", website: "harbor.example", description: "DTC + wholesale coffee. Early — keep warm until next budget cycle.", netsuite_url: null, stage_id: "s-nurture", sort_in_stage: 0, last_activity_at: iso(-9), created_at: iso(-40), updated_at: iso(-9), open_tasks: 0, next_due_at: null },
];

export const SAMPLE_NOTES: Record<string, LeadNote[]> = {
  "l-1": [
    { id: "n-1", lead_id: "l-1", body: "Intro call went well. Controller felt the QuickBooks pain hard.", author: "manual", created_at: iso(-1) },
    { id: "n-2", lead_id: "l-1", body: "They run 14 trucks, 30 staff. Year-end is their forcing function.", author: "manual", created_at: iso(-6) },
  ],
  "l-3": [
    { id: "n-3", lead_id: "l-3", body: "Demoed scheduling module — strong reaction. Looping in their ops lead.", author: "manual", created_at: iso(-2) },
  ],
};

export const SAMPLE_TASKS: Record<string, LeadTask[]> = {
  "l-1": [
    { id: "t-1", lead_id: "l-1", title: "Send pricing one-pager", notes: null, due_at: iso(1), remind_at: null, block_time: false, status: "open", mission_id: null, created_at: iso(-1), completed_at: null },
    { id: "t-2", lead_id: "l-1", title: "Confirm year-end timeline w/ controller", notes: null, due_at: iso(4), remind_at: null, block_time: false, status: "open", mission_id: null, created_at: iso(-1), completed_at: null },
  ],
  "l-2": [
    { id: "t-3", lead_id: "l-2", title: "Build multi-entity demo", notes: "Show intercompany + consolidations.", due_at: iso(3), remind_at: null, block_time: false, status: "open", mission_id: null, created_at: iso(-3), completed_at: null },
  ],
  "l-3": [
    { id: "t-4", lead_id: "l-3", title: "Schedule ops-lead demo", notes: null, due_at: iso(0), remind_at: null, block_time: false, status: "open", mission_id: null, created_at: iso(-2), completed_at: null },
  ],
};
