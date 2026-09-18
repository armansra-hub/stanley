import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const original = readFileSync(resolve(process.cwd(), "supabase/migrations/0043_tam_regrade_coordination.sql"), "utf8");
const candidate = readFileSync(resolve(process.cwd(), "supabase/migrations/0058_tam_successor_parallel_claims.sql"), "utf8");
const body = (sql: string) => sql.slice(sql.indexOf("create or replace function claim_tam_regrade_record("), sql.indexOf("\n$$;", sql.indexOf("create or replace function claim_tam_regrade_record(")) + 4);
const oldAdmission = /  if exists \(\n    select 1 from tam_regrade_records\n    where run_id = v_run_id\n      and netsuite_internal_id <> p_netsuite_internal_id\n      and grade_status = 'reading'\n      and claim_expires_at > v_now\n  \) then\n    raise exception 'another exact TAM record already has the run active lease';\n  end if;/;
const newAdmission = /  -- The run-row lock above[\s\S]*?raise exception 'TAM run active lease capacity reached';\n  end if;/;

describe("0058 September bounded grading claims", () => {
  it("changes only the admission guard; all existing ownership and publication fences are byte-identical", () => {
    expect(body(original).match(oldAdmission)).not.toBeNull();
    expect(body(candidate).match(newAdmission)).not.toBeNull();
    expect(body(candidate).replace(newAdmission, "ADMISSION")).toBe(body(original).replace(oldAdmission, "ADMISSION"));
    expect(candidate.match(/create or replace function /g)).toHaveLength(1);
    expect(candidate).not.toMatch(/(?:update|insert into|delete from) companies/);
  });

  it("serializes admission under the existing run lock, before record update", () => {
    const runLock = candidate.indexOf("select id, status into v_run_id, v_run_status from tam_regrade_runs where slug = p_run_slug for update;");
    const admission = candidate.indexOf("-- The run-row lock above");
    expect(runLock).toBeGreaterThan(0);
    expect(admission).toBeGreaterThan(runLock);
    expect(candidate.indexOf("update tam_regrade_records\n  set grade_status = 'reading'")).toBeGreaterThan(admission);
    expect(candidate).toContain("and claim_actor = p_actor_key");
  });

  it("caps only the exact authorized successor at three; earlier and unknown runs remain one", () => {
    const clause = candidate.match(/>= \(case when p_run_slug = '([^']+)' then (\d+) else (\d+) end\) then/);
    expect(clause?.slice(1)).toEqual(["ars-bs-tam-2026-09-17", "3", "1"]);
    expect(candidate).not.toContain("like 'ars-bs-tam");
    expect(candidate.match(/and netsuite_internal_id <> p_netsuite_internal_id/g)).toHaveLength(2);
    expect(candidate.match(/and claim_expires_at > v_now/g)).toHaveLength(2);
  });

  it("protects CASE's inner THEN from the PL/pgSQL IF condition terminator", () => {
    expect(candidate).not.toMatch(/\)\s*>=\s*case\b/i);
    expect(candidate).toContain(") >= (case when p_run_slug = 'ars-bs-tam-2026-09-17' then 3 else 1 end) then");
  });

  it("still requires a token for same-record resume and rejects foreign actor or expired publication ownership", () => {
    expect(candidate).toContain("if v_record.claim_actor is distinct from p_actor_key then raise exception");
    expect(candidate).toContain("if p_claim_token is null or v_record.claim_token is distinct from p_claim_token then raise exception");
    expect(candidate).toContain("elsif v_record.grade_status = 'reading' then");
    expect(candidate).toContain("v_token := gen_random_uuid();");
    expect(candidate).toContain("where run_id = v_run_id and netsuite_internal_id = p_netsuite_internal_id");
  });

  it("keeps the existing function signature/security context and does not broaden execution grants", () => {
    expect(body(candidate).split("as $$")[0]).toBe(body(original).split("as $$")[0]);
    expect(candidate).not.toMatch(/grant\s+execute|grant\s+all/i);
    expect(candidate).toContain("security definer\nset search_path = public, pg_temp");
  });
});
