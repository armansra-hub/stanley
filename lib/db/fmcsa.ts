import "server-only";
import { serviceClient } from "@/lib/supabase/server";

export interface FmcsaSnapshot {
  nbr_power_unit: number;
  driver_total: number;
  captured_at: string;
}

/** Prior fleet snapshot for a carrier, or null (also null if the table doesn't exist yet). */
export async function getFmcsaSnapshot(dot: string): Promise<FmcsaSnapshot | null> {
  const db = serviceClient();
  const { data, error } = await db
    .from("fmcsa_snapshots")
    .select("nbr_power_unit, driver_total, captured_at")
    .eq("dot_number", dot)
    .maybeSingle();
  if (error) return null; // table missing or error → no delta
  return (data as FmcsaSnapshot | null) ?? null;
}

export async function upsertFmcsaSnapshot(
  dot: string,
  legalName: string,
  units: number,
  drivers: number,
): Promise<void> {
  const db = serviceClient();
  await db
    .from("fmcsa_snapshots")
    .upsert(
      { dot_number: dot, legal_name: legalName, nbr_power_unit: units, driver_total: drivers, captured_at: new Date().toISOString() },
      { onConflict: "dot_number" },
    );
}
