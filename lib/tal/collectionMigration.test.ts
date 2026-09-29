import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../supabase/migrations/0136_tal_news_membership_independence.sql", import.meta.url), "utf8");
const section = (tag: string) => migration.split(`$${tag}$`)[1];
const occurrences = (text: string, fragment: string) => text.split(fragment).length - 1;

describe("independent TAL news admission migration", () => {
  it.each([
    ["observe", "0109_intelligence_symmetric_answer_reuse.sql"],
    ["identity", "0085_federal_identity_research.sql"],
  ])("patches exactly the known %s guard and is idempotent", (name, sourceFile) => {
    const existing = readFileSync(new URL(`../../supabase/migrations/${sourceFile}`, import.meta.url), "utf8");
    const oldGuard = section(`${name}_old`), newGuard = section(`${name}_new`);
    expect(occurrences(existing, oldGuard)).toBe(1);
    expect(occurrences(existing, newGuard)).toBe(0);
    const patched = existing.replace(oldGuard, newGuard);
    expect(occurrences(patched, oldGuard)).toBe(0);
    expect(occurrences(patched, newGuard)).toBe(1);
    expect(patched.replace(newGuard, oldGuard)).toBe(existing);
    expect(newGuard).toContain("or ");
    expect(newGuard).toContain("tal_claimed");
    expect(newGuard).toContain("not ('tam_duplicate'=any(coalesce(");
    expect(newGuard).not.toContain("netsuite_tam");
    expect(newGuard).not.toContain("tam_removed");
  });

  it("fails closed on a changed guard without changing membership, paid gates, or job state", () => {
    expect(migration).toContain("Unexpected intelligence_observe admission guard; review required");
    expect(migration).toContain("Unexpected company_identity_source_context admission guard; review required");
    expect(occurrences(migration, "execute replace(definition,old_guard,new_guard)")).toBe(2);
    expect(migration).not.toMatch(/\b(?:update|insert\s+into|delete\s+from)\s+(?:public\.)?(?:companies|intelligence_\w+)/i);
    expect(migration).not.toContain("intelligence_claim(");
    expect(migration).not.toContain("intelligence_account_question_claim(");
    expect(migration).toMatch(/begin;[\s\S]+notify pgrst,'reload schema';\s*commit;/);
  });
});
