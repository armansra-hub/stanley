/** Human-readable labels for Jev's stored native choices. No new inference. */
const labels: Record<string, string> = {
  actual_company_development: "Company development", evergreen_profile: "Existing business profile",
  editorial_coverage: "Editorial coverage", client_work: "Client work", holiday_greeting: "Holiday greeting",
  promotional_content: "Promotion", incidental_mention: "Incidental mention", subject: "Company is the subject",
  publisher: "Company is the publisher", service_provider: "Company is the provider", customer: "Company is the customer",
  partner: "Company is a partner", namesake: "Different company with similar name",
  commercial_award: "Commercial contract award", government_award: "Government contract award",
  bid_opportunity: "Bid opportunity", bid_submission: "Bid submitted", registration: "Contractor registration",
  existing_contract_delivery: "Existing contract delivery", business_model: "Business model change",
  service_launch: "Service launch", billing_or_finance_process: "Billing / finance process change",
  systems_change: "Systems change", expansion: "Expansion", contract_award: "Contract award",
  closure_or_wind_down: "Closure / wind-down", downsizing: "Downsizing", restructuring: "Restructuring",
  brand_transition: "Brand transition", other: "Other operating change",
};

export default function IntelligenceClassification({ attributes }: { attributes: unknown }) {
  if (!attributes || typeof attributes !== "object") return null;
  const values = attributes as Record<string, unknown>;
  const fields = ["operatingChangeType", "contractActivity", "contentClass", "companyRole"];
  const selected = fields.flatMap(field => {
    const value = values[field];
    return typeof value === "string" && labels[value] && !(value === "contract_award" && values.contractActivity !== "none" && values.contractActivity !== "unknown")
      ? [{ field, value, label: labels[value] }] : [];
  });
  if (!selected.length) return null;
  return <div className="mt-2 flex flex-wrap gap-1.5 text-xs" aria-label="Jev classifications">
    {selected.map(({ field, value, label }) => <span key={field} title="Jev's classification of the selected development" className={`rounded border px-2 py-1 ${["closure_or_wind_down", "downsizing"].includes(value) ? "font-semibold text-[var(--gold)]" : "text-[var(--text-muted)]"}`}>{label}</span>)}
  </div>;
}
