import { OPERATING_COMBINATION_RECIPES } from "./operatingCatalog";
import { OPERATING_TOPICS } from "./profiles";

/** Expand the reviewed AND/OR recipes exactly. This combines cached facts; it
 * does not claim a shared commercial offer or generate a new probability. */
export function operatingRecipe(id: string) {
  const recipe = OPERATING_COMBINATION_RECIPES.find(item => item.id === id);
  if (!recipe) return null;
  const combinations = recipe.branches.flatMap(branch => {
    const required: string[] = [...branch.all, ...branch.legacyAll];
    return branch.any.length ? branch.any.map(id => [...new Set([...required, id])]) : [[...new Set(required)]];
  });
  return { ...recipe, combinations, topics: [...new Set(combinations.flat())] };
}

export const LEGACY_OPERATING_GROUP = {
  label: "Existing operating traits",
  topics: Object.entries(OPERATING_TOPICS).map(([id, [label, definition]]) => ({ id, label, definition })),
};
