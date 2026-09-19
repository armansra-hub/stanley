import React from "react";
import { federalLifecycleFacts, type FederalRow } from "@/lib/publicGrowth/federalPresentation";

export default function FederalAwardLifecycle({ award }: { award: FederalRow }) {
  return <div className="mt-1 text-[var(--text-muted)]" aria-label="Award dates and value definitions">
    {federalLifecycleFacts(award).map((fact) => <div key={fact}>{fact}</div>)}
  </div>;
}
