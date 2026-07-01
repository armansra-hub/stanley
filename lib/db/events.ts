import "server-only";
import { serviceClient } from "@/lib/supabase/server";

/**
 * The suite-wide activity log (app_events, migration 0014). One helper that every
 * module calls so the assistant has a single readable timeline of everything that
 * happened across Headhunter, Missions, and Kill List. Always best-effort — a
 * logging failure (e.g. table not migrated yet) must never break the real action.
 */

export type EventModule = "headhunter" | "missions" | "killlist" | "system";

export interface LogEventOpts {
  summary: string;
  entity_type?: string | null;
  entity_id?: string | null;
  meta?: Record<string, unknown> | null;
}

export async function logEvent(module: EventModule, kind: string, opts: LogEventOpts): Promise<void> {
  try {
    await serviceClient().from("app_events").insert({
      module, kind, summary: opts.summary,
      entity_type: opts.entity_type ?? null, entity_id: opts.entity_id ?? null, meta: opts.meta ?? null,
    });
  } catch {
    /* table missing / transient → never break the caller */
  }
}

export interface AppEvent {
  id: string; ts: string; module: string; kind: string;
  entity_type: string | null; entity_id: string | null; summary: string; meta: Record<string, unknown> | null;
}

/** Read back the timeline (newest first), optionally filtered — for the activity
 * feed UI and for the assistant to answer "what happened ...". */
export async function listEvents(opts: { module?: string; kind?: string; since?: string; limit?: number } = {}): Promise<AppEvent[]> {
  try {
    const db = serviceClient();
    let q = db.from("app_events").select("*").order("ts", { ascending: false });
    if (opts.module) q = q.eq("module", opts.module);
    if (opts.kind) q = q.eq("kind", opts.kind);
    if (opts.since) q = q.gte("ts", opts.since);
    const { data } = await q.limit(opts.limit ?? 200);
    return (data ?? []) as AppEvent[];
  } catch {
    return [];
  }
}
