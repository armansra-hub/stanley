import React from "react";
import FederalAwardLifecycle from "./FederalAwardLifecycle";
import { federalAwardLabel, type FederalCoverage, type FederalRow, type RelatedFederalEntity } from "@/lib/publicGrowth/federalPresentation";
import { FEDERAL_COVERAGE_SOURCES, federalCoverageHeadline, federalIdentityDecision, federalPublicSourceUrl, federalSourcePresentation } from "@/lib/publicGrowth/federalCoveragePresentation";

const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value))
  ? new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : "Date unavailable";
const money = (value: unknown) => Number(value ?? 0).toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function IdentityDecision({ entity }: { entity: FederalRow }) {
  const decision = federalIdentityDecision(entity);
  return <div className="mt-1 text-[var(--text-muted)]">
    <div className="font-medium">{decision.label}</div>
    <p>{decision.detail}</p>
    {decision.raw && <details className="mt-1">
      <summary className="cursor-pointer text-[var(--accent)]">Saved Jev identity decision</summary>
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded border p-2 text-[10px]" style={{ borderColor: "var(--border)" }}>{JSON.stringify(decision.raw, null, 2)}</pre>
    </details>}
  </div>;
}

export default function FederalIdentityContext({ entities, pendingEntities, relatedEntities, coverage }: {
  entities: FederalRow[]; pendingEntities: FederalRow[]; relatedEntities: RelatedFederalEntity[]; coverage: FederalCoverage;
}) {
  const status = federalCoverageHeadline(coverage);
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
        {federalPublicSourceUrl(entity.source_url) ? <a href={federalPublicSourceUrl(entity.source_url)!} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Entity source ↗</a> : null}
        <IdentityDecision entity={entity} />
      </div>)}
    </details>}
    {pendingEntities.length > 0 && <details className="mt-2">
      <summary className="cursor-pointer font-medium">Candidates awaiting identity evidence ({pendingEntities.length})</summary>
      {pendingEntities.map((entity) => <div key={String(entity.id)} className="mt-2 rounded border p-2" style={{ borderColor: "var(--border)" }}>
        <div className="font-semibold">{String(entity.legal_name ?? "Recipient candidate")}</div>
        <div className="text-[var(--text-muted)]">{entity.uei ? `UEI ${String(entity.uei)}` : "UEI unavailable"}{entity.cage_code ? ` · CAGE ${String(entity.cage_code)}` : ""}</div>
        {[entity.city, entity.state, entity.postal_code, entity.country_code].filter(Boolean).length > 0 && <div className="text-[var(--text-muted)]">{[entity.city, entity.state, entity.postal_code, entity.country_code].filter(Boolean).map(String).join(" · ")}</div>}
        {entity.source ? <div className="text-[var(--text-muted)]">{String(entity.source)} · observed {date(entity.observed_at)}</div> : null}
        {federalPublicSourceUrl(entity.source_url) ? <a href={federalPublicSourceUrl(entity.source_url)!} target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Candidate source ↗</a> : null}
        <IdentityDecision entity={entity} />
      </div>)}
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
    <section className="mt-3" aria-label="Federal source coverage">
      <div className="font-semibold">Federal source coverage</div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">{FEDERAL_COVERAGE_SOURCES.map(({ source, label }) => {
        const row = coverage.sources?.find((entry) => entry.source === source);
        const display = federalSourcePresentation(row);
        return <div className="rounded border p-2" style={{ borderColor: "var(--border)" }} key={source}>
          <div className="font-medium">{label}</div>
          <div className="mt-1 font-semibold">{display.label}</div>
          <p className="mt-1 text-[var(--text-muted)]">{display.detail}</p>
          <dl className="mt-1 text-[var(--text-muted)]">
            {row?.last_attempted_at && <div><dt className="inline">Last attempted: </dt><dd className="inline">{date(row.last_attempted_at)}</dd></div>}
            {row?.last_completed_at && <div><dt className="inline">Last completed: </dt><dd className="inline">{date(row.last_completed_at)}</dd></div>}
            {(row?.searched_from || row?.searched_through) && <div><dt className="inline">Search dates: </dt><dd className="inline">{row.searched_from ? date(row.searched_from) : "Start unspecified"} – {row.searched_through ? date(row.searched_through) : "End unspecified"}</dd></div>}
          </dl>
          {row?.detail?.candidateDecision != null && <details className="mt-1">
            <summary className="cursor-pointer">Latest recipient decision · original data</summary>
            <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(row.detail.candidateDecision, null, 2)}</pre>
          </details>}
          {(row?.scope || display.reason || display.collection) && <details className="mt-1 text-[var(--text-muted)]">
            <summary className="cursor-pointer">Search scope and saved detail</summary>
            {row?.scope && <p className="mt-1">{row.scope}</p>}
            {display.reason && <p className="mt-1">Saved reason: {display.reason}</p>}
            {display.collection && <p className="mt-1">Collection: {display.collection}</p>}
          </details>}
        </div>;
      })}</div>
      <details className="mt-2 text-[var(--text-muted)]">
        <summary className="cursor-pointer">What this coverage includes</summary>
        {coverage.gaps.map((gap) => <p className="mt-1" key={gap}>{gap}</p>)}
        <p className="mt-1">Registration and historical awards do not establish a new business event. Fresh events appear separately in signals.</p>
        {coverage.relatedEntitiesTruncated && <p className="mt-1">Related-company context is limited to the first 20 supported entities.</p>}
      </details>
    </section>
  </section>;
}
