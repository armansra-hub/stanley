import React from "react";
import FederalAwardLifecycle from "./FederalAwardLifecycle";
import { FEDERAL_STATUS_TEXT, federalAwardLabel, type FederalCoverage, type FederalRow, type RelatedFederalEntity } from "@/lib/publicGrowth/federalPresentation";

const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
const money = (value: unknown) => Number(value ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default function FederalIdentityContext({ entities, pendingEntities, relatedEntities, coverage }: {
  entities: FederalRow[]; pendingEntities: FederalRow[]; relatedEntities: RelatedFederalEntity[]; coverage: FederalCoverage;
}) {
  const status = FEDERAL_STATUS_TEXT[coverage.status];
  return <section aria-label="Federal identity and coverage" className="mb-3 text-xs">
    <div className="font-semibold">{status.label}</div>
    <p className="mt-1 text-[var(--text-muted)]">{status.detail}</p>
    {coverage.latestAwardObservedAt && <p className="mt-1 text-[var(--text-muted)]">Award evidence last stored {date(coverage.latestAwardObservedAt)}.</p>}
    {entities.length > 0 && <details className="mt-2" open>
      <summary className="cursor-pointer font-medium">Direct verified legal entities ({entities.length})</summary>
      {entities.map((entity) => <div key={String(entity.id)} className="mt-2 border-l pl-2" style={{ borderColor: "var(--border)" }}>
        <div className="font-semibold">{String(entity.legal_name ?? "Verified entity")}</div>
        <div className="text-[var(--text-muted)]">{entity.uei ? `UEI ${String(entity.uei)}` : "UEI unavailable"}{entity.cage_code ? ` · CAGE ${String(entity.cage_code)}` : ""}</div>
        {entity.registration_status ? <div className="text-[var(--text-muted)]">SAM registration: {String(entity.registration_status)}{entity.expiration_date ? ` · expires ${date(entity.expiration_date)}` : ""}</div> : null}
        <div className="text-[var(--text-muted)]">{String(entity.source ?? "Stored evidence")} · observed {date(entity.observed_at)}</div>
        {entity.source_url ? <a href={String(entity.source_url)} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Entity source ↗</a> : null}
      </div>)}
    </details>}
    {pendingEntities.length > 0 && <details className="mt-2">
      <summary className="cursor-pointer text-[var(--text-muted)]">Unverified identity candidates ({pendingEntities.length})</summary>
      {pendingEntities.map((entity) => <div key={String(entity.id)} className="mt-1 text-[var(--text-muted)]">{String(entity.legal_name)} · identity review required</div>)}
    </details>}
    {relatedEntities.length > 0 && <details className="mt-3">
      <summary className="cursor-pointer font-semibold">Related-company federal context ({relatedEntities.length})</summary>
      <p className="mt-1 text-[var(--text-muted)]">These are separate legal entities. Their awards are excluded from this account&apos;s direct totals.</p>
      {relatedEntities.map(({ entity, relationships, awards, awardsTruncated }) => <div key={String(entity.id)} className="mt-2 rounded border p-2" style={{ borderColor: "var(--border)" }}>
        <div className="font-semibold">{String(entity.legal_name)} · UEI {String(entity.uei)}</div>
        {relationships.map((relationship, index) => <p key={index} className="mt-1 text-[var(--text-muted)]">
          {{ reported_parent: "Reported parent of", reported_child: "Reported child of", parent: "Parent of", subsidiary: "Subsidiary of", joint_venture: "Joint venture involving", division: "Division of" }[relationship.relationship]} {relationship.subjectName ?? String(entities.find((direct) => direct.id === relationship.directEntityId)?.legal_name ?? "verified entity")}
          {" · "}<a href={relationship.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">{relationship.source} relationship evidence ↗</a>
          {" · "}observed {date(relationship.observedAt)}
        </p>)}
        {awards.length ? <details className="mt-2">
          <summary className="cursor-pointer">Stored related-entity awards ({awards.length}{awardsTruncated ? "+" : ""})</summary>
          {awards.map((award) => <div key={String(award.id)} className="mt-2 border-t pt-1" style={{ borderColor: "var(--border)" }}>
            <div>{federalAwardLabel(award)} · {money(award.total_obligations)} obligated · {money(award.award_ceiling)} ceiling</div>
            <div className="text-[var(--text-muted)]">{String(award.awarding_agency ?? "Agency unavailable")} · {date(award.start_date)}</div>
            <FederalAwardLifecycle award={award} />
            {award.source_url ? <a href={String(award.source_url)} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Related-entity award source ↗</a> : null}
          </div>)}
          {awardsTruncated && <p className="mt-1 text-[var(--text-muted)]">Showing the 20 most recent stored awards for this related entity.</p>}
        </details> : <p className="mt-1 text-[var(--text-muted)]">No awards stored for this related entity; history coverage remains unresolved.</p>}
      </div>)}
    </details>}
    <details className="mt-2 text-[var(--text-muted)]">
      <summary className="cursor-pointer">Federal coverage: {coverage.historyComplete ? "source histories complete" : "partial"}</summary>
      {["federal-discovery", "usaspending", "usaspending-subawards", "sam-entity"].map((source) => {
        const row = coverage.sources?.find((entry) => entry.source === source);
        const label = { "federal-discovery": "Recipient discovery", usaspending: "Contracts, vehicles and transactions", "usaspending-subawards": "Reported subawards", "sam-entity": "SAM registration" }[source];
        return <p className="mt-1" key={source}>{label}: {row?.status.replaceAll("_", " ") ?? "unsearched"}
          {row?.searched_through ? ` · search through ${row.searched_through}` : ""}
          {row?.last_attempted_at ? ` · last attempted ${date(row.last_attempted_at)}` : ""}
          {row?.scope ? <span className="block">{row.scope}</span> : null}
        </p>;
      })}
      {coverage.gaps.map((gap) => <p className="mt-1" key={gap}>{gap}</p>)}
      <p className="mt-1">Registration and historical awards do not establish a new business event. Fresh events appear separately in signals.</p>
      {coverage.relatedEntitiesTruncated && <p className="mt-1">Related-company context is limited to the first 20 supported entities.</p>}
    </details>
  </section>;
}
