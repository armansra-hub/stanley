# Jev in Codex

The installed `stanley_jev` stdio MCP server exposes `jev_status`,
`jev_evaluate`, and `jev_account_context`. Codex starts the small Python process
when it needs the connection. It is not a continuously running research worker.
Stanley's existing cloud crons own monitoring and collection.

The transport uses Stanley's existing dedicated agent credential and the direct
TypeSafe integration. No new TypeSafe key or Vercel Gateway account is required.
Codex configuration contains executable/workspace paths, never the API key.

Use Jev for a useful first decision: classify the work described in an actual
source, rank next research branches, match reports of an event, or answer a
specific question across attributed account evidence. Supply the company name,
domain, known aliases, relevant identity/location context, source dates and the
actual passages. State missing information as unknown. Do not use this connector
to ask a second model to approve or recheck a Jev answer.

`jev_evaluate` accepts the native `noul`, `choice`, and `score` question types.
The response preserves TypeSafe's answer values, confidence, distributions,
model and usage. The local connector reuses an identical saved request. An
uncertain network outcome retains its intent and does not blindly make another
paid request. Changed evidence or questions creates a new attributed request.

Privacy is explicit: use `public` only for public source material. Relevant
authorized NetSuite notes/excerpts use `private_excerpt`; these never enter the
shared public-response cache. Private receipts stay under the existing private
workspace output directory. Every paid request uses Stanley's existing budget
accounting and appears as **Jev in Codex**. This is TypeSafe usage, separate from
a Codex subscription.

The registration is global to this Codex installation. A running task whose tool
inventory was already loaded may need its connection refreshed or a new task
before the three MCP tools appear. No running TAM coordinator needs restarting.

The connector cannot change a TAM grade, CRM record, send outreach or run an
arbitrary remote request. Grading continues through its canonical full-record,
independent-validation and publication workflow.
