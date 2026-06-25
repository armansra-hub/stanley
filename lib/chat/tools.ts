import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import {
  getCompanies,
  setCompaniesStatus,
  recordExport,
  setCompanyNote,
  patchTerritoryConfig,
} from "@/lib/db/companies";
import type { Company, Signal } from "@/lib/types";

/** Tools the chat agent can call. Reads run freely; writes are confirm-gated. */
export const CHAT_TOOLS: Anthropic.Tool[] = [
  {
    name: "query_companies",
    description:
      "Find companies on the dashboard by filters. Returns id, name, domain, subindustry, state, score, tier, source, status, and the strongest signal. Call this before any write so you have the company ids.",
    input_schema: {
      type: "object",
      properties: {
        tier: { type: "string", enum: ["A", "B", "C"] },
        subindustry: { type: "string" },
        state: { type: "string", description: "2-letter code, e.g. TX" },
        signal_type: { type: "string", description: "e.g. finance_hire, m_and_a, fleet_expansion" },
        source: { type: "string", enum: ["discovered", "imported"] },
        status: { type: "string", enum: ["new", "reviewed", "dismissed", "exported_sql", "exported_csv"] },
        search: { type: "string", description: "substring match on name or domain" },
        min_score: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "explain_company",
    description: "Explain why a company is on the list: its signals, evidence, and reasoning. Look up by id or name.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, name: { type: "string" } },
    },
  },
  {
    name: "territory_stats",
    description: "Summary counts: totals by source, tier, status, and top subindustries.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "dismiss",
    description: "Dismiss companies by id (hides them from the default feed).",
    input_schema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "mark_exported",
    description: "Mark companies exported by id (so they won't resurface as new).",
    input_schema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        type: { type: "string", enum: ["sql", "csv"] },
      },
      required: ["ids"],
    },
  },
  {
    name: "add_note",
    description: "Add/replace a note on one company (by id).",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, text: { type: "string" } },
      required: ["id", "text"],
    },
  },
  {
    name: "update_territory_config",
    description: "Add or remove states / subindustries from the territory config.",
    input_schema: {
      type: "object",
      properties: {
        add_states: { type: "array", items: { type: "string" } },
        add_subindustries: { type: "array", items: { type: "string" } },
        remove_states: { type: "array", items: { type: "string" } },
        remove_subindustries: { type: "array", items: { type: "string" } },
      },
    },
  },
];

export const WRITE_TOOLS = new Set(["dismiss", "mark_exported", "add_note", "update_territory_config"]);
export const isWriteTool = (name: string) => WRITE_TOOLS.has(name);

function strongest(c: Company): Signal | null {
  if (!c.signals.length) return null;
  return [...c.signals].sort((a, b) => b.weight - a.weight)[0];
}

function summarize(c: Company) {
  const top = strongest(c);
  return {
    id: c.id,
    name: c.name,
    domain: c.domain,
    subindustry: c.subindustry,
    state: c.state,
    score: c.signal_score,
    tier: c.score_tier,
    source: c.source,
    status: c.status,
    strongest_signal: top ? { type: top.type, why: top.signal_summary, source: top.source_url } : null,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function executeReadTool(name: string, input: any): Promise<string> {
  const companies = await getCompanies();
  if (name === "query_companies") {
    let rows = companies;
    if (input.source) rows = rows.filter((c) => c.source === input.source);
    else rows = rows.filter((c) => c.status !== "dismissed" && !c.status.startsWith("exported"));
    if (input.tier) rows = rows.filter((c) => c.score_tier === input.tier);
    if (input.subindustry)
      rows = rows.filter((c) => (c.subindustry ?? "").toLowerCase().includes(String(input.subindustry).toLowerCase()));
    if (input.state) rows = rows.filter((c) => (c.state ?? "").toUpperCase() === String(input.state).toUpperCase());
    if (input.signal_type) rows = rows.filter((c) => c.signals.some((s) => s.type === input.signal_type));
    if (input.status) rows = rows.filter((c) => c.status === input.status);
    if (input.min_score != null) rows = rows.filter((c) => c.signal_score >= Number(input.min_score));
    if (input.search) {
      const q = String(input.search).toLowerCase();
      rows = rows.filter((c) => c.name.toLowerCase().includes(q) || (c.domain ?? "").includes(q));
    }
    rows = rows.sort((a, b) => b.signal_score - a.signal_score).slice(0, Number(input.limit) || 25);
    return JSON.stringify({ count: rows.length, companies: rows.map(summarize) });
  }
  if (name === "explain_company") {
    const c = companies.find(
      (x) => x.id === input.id || x.name.toLowerCase() === String(input.name ?? "").toLowerCase(),
    );
    if (!c) return JSON.stringify({ error: "company not found" });
    return JSON.stringify({
      name: c.name,
      subindustry: c.subindustry,
      state: c.state,
      score: c.signal_score,
      tier: c.score_tier,
      score_reason: c.score_reason,
      signals: c.signals.map((s) => ({ type: s.type, strength: s.strength, why: s.signal_summary, source: s.source_url })),
    });
  }
  if (name === "territory_stats") {
    const by = (fn: (c: Company) => string) =>
      companies.reduce<Record<string, number>>((m, c) => ((m[fn(c)] = (m[fn(c)] ?? 0) + 1), m), {});
    return JSON.stringify({
      total: companies.length,
      by_source: by((c) => c.source),
      by_tier: by((c) => c.score_tier ?? "none"),
      by_status: by((c) => c.status),
      by_subindustry: by((c) => c.subindustry ?? "out_of_territory"),
    });
  }
  return JSON.stringify({ error: `unknown read tool ${name}` });
}

export async function executeWriteTool(name: string, input: any): Promise<string> {
  if (name === "dismiss") {
    await setCompaniesStatus(input.ids, "dismissed");
    return `Dismissed ${input.ids.length} compan${input.ids.length === 1 ? "y" : "ies"}.`;
  }
  if (name === "mark_exported") {
    const type = input.type === "csv" ? "csv" : "sql";
    await recordExport(type, input.ids, "(marked exported via chat)");
    return `Marked ${input.ids.length} exported (${type}).`;
  }
  if (name === "add_note") {
    await setCompanyNote(input.id, input.text);
    return `Note saved.`;
  }
  if (name === "update_territory_config") {
    const res = await patchTerritoryConfig(input);
    return `Territory updated: ${res.states.length} states, ${res.subindustries.length} subindustries.`;
  }
  return `unknown write tool ${name}`;
}

/** Human-readable description of a pending write, with company names resolved. */
export async function describeWrite(name: string, input: any): Promise<string> {
  if (name === "update_territory_config") {
    const parts: string[] = [];
    if (input.add_states?.length) parts.push(`add states ${input.add_states.join(", ")}`);
    if (input.remove_states?.length) parts.push(`remove states ${input.remove_states.join(", ")}`);
    if (input.add_subindustries?.length) parts.push(`add ${input.add_subindustries.join(", ")}`);
    if (input.remove_subindustries?.length) parts.push(`remove ${input.remove_subindustries.join(", ")}`);
    return `Update territory: ${parts.join("; ") || "(no changes)"}`;
  }
  const companies = await getCompanies();
  const nameFor = (id: string) => companies.find((c) => c.id === id)?.name ?? id;
  if (name === "dismiss") return `Dismiss: ${(input.ids ?? []).map(nameFor).join(", ")}`;
  if (name === "mark_exported")
    return `Mark exported (${input.type ?? "sql"}): ${(input.ids ?? []).map(nameFor).join(", ")}`;
  if (name === "add_note") return `Add note to ${nameFor(input.id)}: “${input.text}”`;
  return `${name} ${JSON.stringify(input)}`;
}
