export interface SamEntityQuery {
  uei?: string;
  cageCode?: string;
  legalBusinessName?: string;
  dbaName?: string;
}
export interface SamEntityTarget {
  query: SamEntityQuery;
  /** Present only for an existing verified binding, never for a name guess. */
  binding?: { entityId: string; uei: string | null; cageCode: string | null };
}
export interface SamEntityContinuation {
  version: 1;
  companyId: string;
  targets: SamEntityTarget[];
  targetIndex: number;
  page: number;
  lastPageHash: string | null;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function parseSamEntityContinuation(value: unknown, companyId: string): SamEntityContinuation {
  const row = value as SamEntityContinuation;
  if (!row || row.version !== 1 || row.companyId !== companyId || !UUID.test(companyId)
    || !Array.isArray(row.targets) || row.targets.length < 1 || row.targets.length > 402
    || !Number.isInteger(row.targetIndex) || row.targetIndex < 0 || row.targetIndex >= row.targets.length
    || !Number.isInteger(row.page) || row.page < 0 || row.page > 999
    || !(row.lastPageHash === null || typeof row.lastPageHash === "string" && /^[a-f0-9]{64}$/i.test(row.lastPageHash))) throw new Error("invalid SAM entity continuation");
  const targets = row.targets.map((target) => {
    if (!target || !target.query || Object.keys(target.query).length !== 1) throw new Error("invalid SAM entity target");
    const [key, value] = Object.entries(target.query)[0];
    if (!["uei", "cageCode", "legalBusinessName", "dbaName"].includes(key) || typeof value !== "string" || !value.trim() || value.length > 500
      || key === "uei" && !/^[A-Z0-9]{12}$/i.test(value) || key === "cageCode" && !/^[A-Z0-9]{5}$/i.test(value)) throw new Error("invalid SAM query");
    if (target.binding && (!UUID.test(target.binding.entityId) || !(target.binding.uei || target.binding.cageCode)
      || target.binding.uei !== null && !/^[A-Z0-9]{12}$/i.test(target.binding.uei)
      || target.binding.cageCode !== null && !/^[A-Z0-9]{5}$/i.test(target.binding.cageCode))) throw new Error("invalid SAM entity binding");
    return { query: { ...target.query }, ...(target.binding ? { binding: { ...target.binding } } : {}) };
  });
  return { version: 1, companyId, targets, targetIndex: row.targetIndex, page: row.page, lastPageHash: row.lastPageHash };
}

/** All supplied identifiers must agree; one agreeing key cannot hide a conflict. */
export function samBindingMatches(binding: NonNullable<SamEntityTarget["binding"]>, candidate: { uei: string | null; cageCode: string | null }): boolean {
  const uei = candidate.uei?.toUpperCase() ?? null, cage = candidate.cageCode?.toUpperCase() ?? null;
  if (binding.uei && uei && binding.uei.toUpperCase() !== uei || binding.cageCode && cage && binding.cageCode.toUpperCase() !== cage) return false;
  return Boolean(binding.uei && binding.uei.toUpperCase() === uei || binding.cageCode && binding.cageCode.toUpperCase() === cage);
}
