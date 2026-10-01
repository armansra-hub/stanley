/** Offline native contract validation for an explicit private dictionary file. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { customerRuntimeCatalog, runtimeFacetRegistration } from "../lib/intelligence/customerCatalogRuntime";
import { catalogAnswerPlans, catalogPackets } from "../lib/intelligence/operatingCoverage";
import { nativeJevBody } from "../lib/intelligence/nativeJev";
const path = process.argv[2];
if (!path) throw new Error("usage: private-approved-catalog.json");
const text = readFileSync(path, "utf8"), catalog = customerRuntimeCatalog(JSON.parse(text));
const packets = catalogPackets([{ id: "synthetic-source", content_hash: "synthetic-hash", source_url: "https://example.test/business",
  title: "Synthetic business evidence", source_kind: "website", event_date: null, observed_at: "2026-10-01T00:00:00Z",
  evidence_text: "Synthetic target business evidence. This offline fixture does not make any business classification." }]);
const plans = catalogAnswerPlans({ name: "Synthetic target", subindustry: null }, catalog.facets, packets, undefined, [], catalog);
if (plans.blocked.length || plans.plans.flatMap(p => p.facetIds).length !== catalog.facets.length) throw new Error("incomplete_runtime_plan");
const bytes = plans.plans.map(p => Buffer.byteLength(JSON.stringify(nativeJevBody(p.input))));
console.log(JSON.stringify({ schema: "customer-runtime-offline-contract-v1", dictionarySha256: createHash("sha256").update(text).digest("hex"),
  catalogVersion: catalog.version, criteria: catalog.facets.filter(f => f.role === "criterion").length,
  industryContexts: catalog.facets.filter(f => f.role === "industry_context").length,
  nativeWireIdsValid: runtimeFacetRegistration(catalog).every(f => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(f.wireId)),
  questions: catalog.facets.length, syntheticRequestCount: plans.plans.length, maximumSyntheticRequestBytes: Math.max(...bytes),
  providerCalls: 0, classificationDecisions: 0 }));
