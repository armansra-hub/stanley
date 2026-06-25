import SettingsForm from "@/components/SettingsForm";
import { getTerritoryConfig } from "@/lib/db/companies";
import { getAppConfig, getScoringWeightsMap, getActorOverrides } from "@/lib/db/settings";
import { ACTORS } from "@/config/actors";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [territory, app, weights, overrides] = await Promise.all([
    getTerritoryConfig(),
    getAppConfig(),
    getScoringWeightsMap(),
    getActorOverrides(),
  ]);

  const actors = Object.entries(ACTORS)
    .sort((a, b) => a[1].rank - b[1].rank)
    .map(([key, a]) => ({
      key,
      actor_id: a.actor_id,
      rank: a.rank,
      price: a.price,
      output: a.output,
      enabled: overrides[key]?.enabled ?? a.enabled,
      setup_note: a.setup_note ?? null,
    }));

  return (
    <SettingsForm
      territory={territory}
      app={app}
      weights={weights}
      actors={actors}
    />
  );
}
