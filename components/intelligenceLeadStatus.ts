export type IntelligenceLeadStatus = "new" | "dismissed";
export type IntelligenceStatusOverrides = Record<string, IntelligenceLeadStatus>;

export function hiddenIntelligenceLead(status?: string): boolean {
  return status === "reviewed" || status === "dismissed" || status === "removed_from_tam" || Boolean(status?.startsWith("exported"));
}

/** Apply local decisions at render time so an older in-flight read cannot undo them. */
export function visibleIntelligenceRows<T extends { company_id: string | null; company_status?: string }>(
  rows: T[], overrides: IntelligenceStatusOverrides, showHidden: boolean,
): T[] {
  return rows.flatMap(row => {
    const status = row.company_id ? overrides[row.company_id] ?? row.company_status : row.company_status;
    return !showHidden && hiddenIntelligenceLead(status) ? [] : [{ ...row, company_status: status }];
  });
}

export async function saveIntelligenceLeadStatus(ids: string[], status: IntelligenceLeadStatus): Promise<void> {
  const exactIds = [...new Set(ids)];
  const response = await fetch("/api/companies/status", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: exactIds, status }), signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("status_save_failed");
  const receipt = await response.json();
  const saved = new Set(receipt.ids);
  if (receipt.ok !== true || receipt.count !== exactIds.length || saved.size !== exactIds.length || exactIds.some(id => !saved.has(id))) {
    throw new Error("status_receipt_mismatch");
  }
}
