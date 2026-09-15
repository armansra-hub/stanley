/** Form 5500's maintained importer normalization; deliberately source-specific. */
const NOISE = /\b(llc|inc|incorporated|corp|corporation|co|company|ltd|limited|lp|llp|plc|pllc|group|holdings|holding|the)\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function normalizeForm5500Name(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
    .replace(NOISE, " ").replace(/\s+/g, " ").trim();
}

type IdentityInput = {
  companyId: string;
  sponsorName: string;
  sponsorDba?: string | null;
  sponsorState?: string | null;
  sponsorCity?: string | null;
  matchMethod: "unique_exact_name" | "exact_name_state_city";
  matchConfidence: number;
};

const optionalText = (value: unknown) => value == null || typeof value === "string";

/** The TypeScript input type does not validate a caller's JSON. */
export function isForm5500IdentityInput(value: unknown): value is IdentityInput {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.companyId === "string" && UUID.test(row.companyId)
    && typeof row.sponsorName === "string"
    && optionalText(row.sponsorDba) && optionalText(row.sponsorState) && optionalText(row.sponsorCity)
    && ((row.matchMethod === "unique_exact_name" && row.matchConfidence === 0.91)
      || (row.matchMethod === "exact_name_state_city" && row.matchConfidence === 0.98));
}

/** Recheck the claimed identity against current canonical fields before any write.
 * Name uniqueness across the TAM remains the importer's responsibility. */
export function form5500IdentitySupported(
  company: { id: string; name: string | null; state?: string | null; city?: string | null },
  input: unknown,
): boolean {
  if (!isForm5500IdentityInput(input) || company.id !== input.companyId) return false;
  if (typeof company.name !== "string" || !optionalText(company.state) || !optionalText(company.city)) return false;
  const name = normalizeForm5500Name(company.name);
  if (name.length < 4 || ![input.sponsorName, input.sponsorDba].some((value) => normalizeForm5500Name(value) === name)) return false;
  const companyState = (company.state ?? "").trim().toUpperCase();
  const sourceState = (input.sponsorState ?? "").trim().toUpperCase();
  if (companyState && sourceState && companyState !== sourceState) return false;
  if (input.matchMethod === "exact_name_state_city") {
    const companyCity = normalizeForm5500Name(company.city), sourceCity = normalizeForm5500Name(input.sponsorCity);
    return Boolean(companyState && sourceState && companyState === sourceState
      && companyCity && sourceCity && companyCity === sourceCity);
  }
  return true;
}
