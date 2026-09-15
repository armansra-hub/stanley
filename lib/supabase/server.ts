import "server-only";
import { createClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";

const serviceDeadlines = new AsyncLocalStorage<number>();

/** Opt-in deadline follows nested storage helpers without changing other requests. */
export function withServiceDeadline<T>(deadlineMs: number, operation: () => Promise<T>): Promise<T> {
  if (!Number.isFinite(deadlineMs)) throw new Error("Invalid service request deadline");
  return serviceDeadlines.run(Math.min(deadlineMs, serviceDeadlines.getStore() ?? Infinity), operation);
}

export function deadlineFetch(deadlineMs: number): typeof fetch {
  return async (input, init) => {
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) throw new Error("Service request deadline reached");
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(15_000, remaining)));
    const inherited = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    return fetch(input, { ...init, redirect: "error", signal: inherited ? AbortSignal.any([inherited, timeout]) : timeout });
  };
}

/**
 * Server-side Supabase client using the SERVICE ROLE (secret) key. Bypasses RLS
 * — never import this into a client component. All ingestion + dashboard reads
 * go through here for v1 (single-user, auth deferred to a later phase).
 */
export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase env missing: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  }
  const deadlineMs = serviceDeadlines.getStore();
  return createClient(url, key, { auth: { persistSession: false }, ...(deadlineMs === undefined ? {} : { global: { fetch: deadlineFetch(deadlineMs) } }) });
}

/** True when Supabase env is configured (lets pages fall back to sample data in dev). */
export function hasSupabaseEnv(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
