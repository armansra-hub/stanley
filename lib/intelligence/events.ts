import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export type EventSource = { observationId: string; url: string; title: string; eventDate: string | null;
  observedAt: string; excerpt: string | null; current: boolean; excluded: boolean };
export type IntelligenceEvent = { id: string; company_id: string; event_type: string; title: string;
  event_date: string | null; primary_source_url: string; trigger_id: string | null; evidence_count: number;
  revision: number; updated_at: string; sources?: EventSource[] };

/** Grouping is ordinary source deduplication. It never modifies Jev's answers,
 * promotes a finding, or interprets a negative/unknown answer as a fact. The RPC
 * serializes per account, so simultaneous syndicated reports have one owner. */
export async function attachObservationEvent(observationId: string, attributes?: Record<string, unknown>): Promise<IntelligenceEvent | null> {
  const { data, error } = await serviceClient().rpc("intelligence_event_attach", {
    p_observation: observationId, p_attributes: attributes ?? null,
  });
  if (error) throw new Error(`Event grouping failed: ${error.code ?? "database_error"}`);
  return data as IntelligenceEvent | null;
}

/** Retains the original trigger and adds links to subsequent source reports. */
export async function bindEventTrigger(eventId: string, triggerId: string): Promise<void> {
  const { data, error } = await serviceClient().rpc("intelligence_event_bind_trigger", {
    p_event: eventId, p_trigger: triggerId,
  });
  if (error || data !== true) throw new Error(`Event trigger binding failed: ${error?.code ?? "binding_mismatch"}`);
}

export async function loadAccountEvents(companyId: string, limit = 30): Promise<IntelligenceEvent[]> {
  const { data, error } = await serviceClient().rpc("intelligence_account_events", {
    p_company: companyId, p_limit: Math.max(1, Math.min(50, Math.floor(limit))),
  });
  if (error) throw new Error(`Account events unavailable: ${error.code ?? "database_error"}`);
  return (data ?? []) as IntelligenceEvent[];
}
