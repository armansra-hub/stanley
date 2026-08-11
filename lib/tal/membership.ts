export interface TalMembershipRow {
  name?: string;
  website?: string | null;
  internal_id?: string | null;
}

export interface TalCompanyIdentity {
  id: string;
  name: string;
  netsuite_internal_id: string | null;
  tal_claimed: boolean;
  tal_dq?: boolean;
  lists?: string[] | null;
}

export interface TalMembershipAssignment {
  company: TalCompanyIdentity;
  row: TalMembershipRow & { internal_id: string };
}

export interface TalInvalidRow {
  index: number;
  name: string;
  internal_id: string | null;
  reason: "missing_internal_id" | "invalid_internal_id";
}

export interface TalAmbiguousRow {
  row: TalMembershipRow & { internal_id: string };
  company_ids: string[];
}

export interface ExactTalResolution {
  assignments: TalMembershipAssignment[];
  uniqueRows: (TalMembershipRow & { internal_id: string })[];
  duplicateInputIds: string[];
  invalidRows: TalInvalidRow[];
  unmatched: (TalMembershipRow & { internal_id: string })[];
  ambiguous: TalAmbiguousRow[];
}

function normalizeInternalId(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return /^\d+$/.test(normalized) ? normalized : null;
}

function isRetiredDuplicate(company: TalCompanyIdentity): boolean {
  return Array.isArray(company.lists) && company.lists.includes("tam_duplicate");
}

/**
 * Resolve a complete TAL upload by exact NetSuite Internal ID only.
 *
 * Names and domains are retained as receipt context, but never participate in
 * identity. An unresolved or ambiguous ID is returned to the caller so the
 * entire import can fail before changing any membership flags.
 */
export function resolveExactTalMembership(
  rows: TalMembershipRow[],
  companies: TalCompanyIdentity[],
): ExactTalResolution {
  const uniqueRows: (TalMembershipRow & { internal_id: string })[] = [];
  const duplicateInputIds: string[] = [];
  const invalidRows: TalInvalidRow[] = [];
  const seenIds = new Set<string>();

  rows.forEach((raw, index) => {
    const name = String(raw?.name ?? "").trim();
    const supplied = raw?.internal_id == null ? null : String(raw.internal_id).trim();
    const internalId = normalizeInternalId(supplied);
    if (!supplied) {
      invalidRows.push({ index, name, internal_id: supplied, reason: "missing_internal_id" });
      return;
    }
    if (!internalId) {
      invalidRows.push({ index, name, internal_id: supplied, reason: "invalid_internal_id" });
      return;
    }
    if (seenIds.has(internalId)) {
      duplicateInputIds.push(internalId);
      return;
    }
    seenIds.add(internalId);
    uniqueRows.push({
      name,
      website: raw.website == null ? null : String(raw.website).trim(),
      internal_id: internalId,
    });
  });

  const companiesByInternalId = new Map<string, TalCompanyIdentity[]>();
  for (const company of companies) {
    const internalId = normalizeInternalId(company.netsuite_internal_id);
    if (!internalId || isRetiredDuplicate(company)) continue;
    const bucket = companiesByInternalId.get(internalId) ?? [];
    bucket.push(company);
    companiesByInternalId.set(internalId, bucket);
  }

  const assignments: TalMembershipAssignment[] = [];
  const unmatched: (TalMembershipRow & { internal_id: string })[] = [];
  const ambiguous: TalAmbiguousRow[] = [];
  for (const row of uniqueRows) {
    const candidates = companiesByInternalId.get(row.internal_id) ?? [];
    if (candidates.length === 0) {
      unmatched.push(row);
    } else if (candidates.length > 1) {
      ambiguous.push({ row, company_ids: candidates.map((company) => company.id).sort() });
    } else {
      assignments.push({ row, company: candidates[0] });
    }
  }

  return {
    assignments,
    uniqueRows,
    duplicateInputIds: [...new Set(duplicateInputIds)].sort(),
    invalidRows,
    unmatched,
    ambiguous,
  };
}
