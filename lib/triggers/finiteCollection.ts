import type { SweepOutcome } from "./sweepOutcomes";

/** An explicit finite admission set, not a second work queue or completion ledger. */
export interface FiniteCollectionScope { companyIds: string[]; runCutoff: string }
export type FiniteCollectionResult = {
  collection?: {
    runCutoff: string;
    requestedCompanyIds: string[];
    outcomes: Array<{ companyId: string; admission: "attempted"; collectorOutcome: SweepOutcome } | { companyId: string; admission: "not_reserved"; reason: "unknown" }>;
    coverage: "reservation_and_collector_outcomes_only";
    analysisCompleted: false;
  };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function validateFiniteScope(scope: FiniteCollectionScope, now = Date.now()): void {
  if (!Array.isArray(scope.companyIds) || scope.companyIds.length < 1 || scope.companyIds.length > 100
    || scope.companyIds.some(id => typeof id !== "string" || !UUID.test(id))
    || new Set(scope.companyIds.map(id => id.toLowerCase())).size !== scope.companyIds.length) {
    throw new Error("companyIds must contain 1 to 100 distinct UUIDs");
  }
  const time = typeof scope.runCutoff === "string" ? Date.parse(scope.runCutoff) : NaN;
  if (!UTC.test(scope.runCutoff) || !Number.isFinite(time) || time > now
    || new Date(time).toISOString().slice(0, 19) !== scope.runCutoff.slice(0, 19)) {
    throw new Error("runCutoff must be a real, nonfuture UTC timestamp");
  }
}

export function assertFiniteCollection(scope: FiniteCollectionScope | undefined, options: {
  limit: number; sourceOnly?: boolean; offset?: number; finance?: boolean; scope?: "claimable" | "tail";
}): void {
  if (!scope) return;
  validateFiniteScope(scope);
  if (options.sourceOnly !== true || (options.offset ?? 0) !== 0 || options.finance || options.scope === "tail") {
    throw new Error("Finite collection requires sourceOnly=1, zero offset, no finance and no tail scope");
  }
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > scope.companyIds.length) {
    throw new Error("Finite collection limit must be 1 to the requested company count");
  }
}

/** Only activates when either manual scope key is present; legacy parsing is unchanged. */
export function parseFiniteCollection(params: URLSearchParams): { collection: FiniteCollectionScope; limit: number } | undefined {
  if (!params.has("companyIds") && !params.has("runCutoff")) return undefined;
  for (const key of ["companyIds", "runCutoff", "sourceOnly", "n", "offset", "finance", "scope"]) {
    if (params.getAll(key).length > 1) throw new Error(`Duplicate ${key} parameter`);
  }
  if (!params.has("companyIds") || !params.has("runCutoff")) throw new Error("companyIds and runCutoff must be supplied together");
  const collection = { companyIds: params.get("companyIds")!.split(",").map(id => id.toLowerCase()), runCutoff: params.get("runCutoff")! };
  validateFiniteScope(collection);
  const limitText = params.get("n");
  const limit = limitText === null ? collection.companyIds.length : /^\d+$/.test(limitText) ? Number(limitText) : NaN;
  const offsetText = params.get("offset");
  if (offsetText !== null && offsetText !== "0") throw new Error("Finite collection requires zero offset");
  if (params.has("finance") && params.get("finance") !== "0") throw new Error("Finite collection cannot use finance mode");
  if (params.has("scope") && params.get("scope") !== "claimable") throw new Error("Finite collection requires claimable scope");
  assertFiniteCollection(collection, { limit, sourceOnly: params.get("sourceOnly") === "1" });
  return { collection, limit };
}

/** Never infer why an ID was not reserved, nor turn an attempt into reviewed coverage. */
export function finiteCollectionAccounting(scope?: FiniteCollectionScope) {
  const attempted = new Map<string, SweepOutcome>();
  return {
    record(companyId: string, outcome: SweepOutcome) { if (scope) attempted.set(companyId.toLowerCase(), outcome); },
    result(): FiniteCollectionResult {
      if (!scope) return {};
      return { collection: { runCutoff: scope.runCutoff, requestedCompanyIds: [...scope.companyIds],
        outcomes: scope.companyIds.map(companyId => attempted.has(companyId.toLowerCase())
          ? { companyId, admission: "attempted" as const, collectorOutcome: attempted.get(companyId.toLowerCase())! }
          : { companyId, admission: "not_reserved" as const, reason: "unknown" as const }),
        coverage: "reservation_and_collector_outcomes_only", analysisCompleted: false } };
    },
  };
}
