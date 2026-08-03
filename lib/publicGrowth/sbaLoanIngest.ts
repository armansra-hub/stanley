import "server-only";
import { serviceClient } from "@/lib/supabase/server";
import { recomputePriority } from "@/lib/db/triggers";
import { recordPublicGrowthTriggersBulk } from "./storage";

export interface SbaLoanObservationInput {
  companyId: string;
  program: "7(a)" | "504";
  locationId: string;
  borrowerName: string;
  borrowerCity?: string | null;
  borrowerState: string;
  approvalDate: string;
  grossApproval: number;
  lender?: string | null;
  naicsCode?: string | null;
  naicsDescription?: string | null;
  matchMethod: "exact_name_city_state" | "exact_name_state";
  matchConfidence: number;
  sourceUrl: string;
}

export async function ingestSbaLoanObservations(rows: SbaLoanObservationInput[]) {
  const db = serviceClient();
  const companyIds = [...new Set(rows.map((row) => row.companyId))];
  const { data: allowed, error } = await db.from("companies").select("id")
    .in("id", companyIds).contains("lists", ["netsuite_tam"]).neq("status", "removed_from_tam");
  if (error) throw new Error(`SBA TAM validation failed: ${error.message}`);
  const allow = new Set((allowed ?? []).map((row) => String(row.id)));
  const accepted = rows.filter((row) => allow.has(row.companyId));
  const triggers = await recordPublicGrowthTriggersBulk(accepted.map((row) => {
    const amount = Math.round(row.grossApproval);
    const place = [row.borrowerCity, row.borrowerState].filter(Boolean).join(", ");
    const lender = row.lender ? ` Lender: ${row.lender}.` : "";
    const industry = row.naicsDescription || row.naicsCode;
    return {
      companyId: row.companyId,
      sourceName: `SBA ${row.program} FOIA`,
      sourceUrl: row.sourceUrl,
      confidence: row.matchConfidence,
      event: {
        family: "growth_financing",
        type: "sba_loan",
        dedupeKey: `sba:${row.program}:${row.locationId}:${row.approvalDate}:${amount}`,
        strength: 75,
        summary: `SBA ${row.program} loan approved ${row.approvalDate} — ${amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })}. Filed as ${row.borrowerName}${place ? ` (${place})` : ""}.${industry ? ` Industry: ${industry}.` : ""}${lender}`,
        signalDate: row.approvalDate,
        metadata: { program: row.program, locationId: row.locationId, grossApproval: amount, borrowerName: row.borrowerName, borrowerCity: row.borrowerCity, borrowerState: row.borrowerState, lender: row.lender, naicsCode: row.naicsCode, naicsDescription: row.naicsDescription, matchMethod: row.matchMethod },
      },
    };
  }));
  for (const companyId of new Set(accepted.map((row) => row.companyId))) await recomputePriority(companyId);
  return { received: rows.length, accepted: accepted.length, rejected: rows.length - accepted.length, triggers, companies: new Set(accepted.map((row) => row.companyId)).size };
}
