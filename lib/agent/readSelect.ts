const columns = (value: string): readonly string[] =>
  Object.freeze(value.trim().split(/\s+/).filter(Boolean));

/** Explicit scalar-column contract for the read bridge. */
export const READABLE_SCALAR_COLUMNS = Object.freeze({
  companies: columns(`
    id name domain website_raw description subindustry ns_industry in_territory
    territory_fit source status state city employee_band revenue_band signal_score
    score_tier score_reason has_new_signal sources import_batch_id notes first_seen_at
    last_updated_at exported_at already_on_netsuite starred rating rating_comment
    rated_at is_base lead_vendor fit_weight technologies erp_ready employee_count
    lists claimable last_checked_at priority netsuite_internal_id erp_incumbent
    pe_owned ats_type ats_token ats_checked_at signals_checked_at tal_claimed tal_dq
    thumbs_down tal_alert site_hash site_checked_at headcount_growth_pct has_parent
    parent_name parent_confidence last_sql_date qual_note qual_hash oldgold_score
    oldgold_class oldgold_reasons record_digest record_dead record_dead_reason
    revisit_on tam_score tam_provisional claim_bullets active_participant_count
    codex_score score_adjust_note linkedin_url linkedin_checked_at linkedin_phase
    fmcsa_checked_at sos_checked_at priority_recompute_reserved_at
  `),
  triggers: columns(`
    id company_id type strength half_life_days summary source_name source_url
    signal_date detected_at family confidence dedupe_key metadata
  `),
  trigger_candidates: columns(`
    id company_id netsuite_internal_id company_name type summary source_name source_url
    signal_date strength half_life_days verdict verdict_reason verdict_by
    promoted_trigger_id created_at decided_at
  `),
  signals: columns(`
    id company_id type strength weight source_name source_url raw_excerpt
    signal_summary subindustry_relevant detected_at signal_date
  `),
  exports: columns(`id export_type company_ids payload created_at origin`),
  app_events: columns(`id ts module kind entity_type entity_id summary meta created_at`),
  lead_documents: columns(`
    id netsuite_internal_id company_id doc_type source title body sha256 captured_at created_at
  `),
  lead_pool: columns(`
    key name domain state city source first_seen_at last_checked_at check_count promoted_at exported_at
  `),
  leads: columns(`
    id name website description netsuite_url stage_id sort_in_stage last_activity_at
    created_at updated_at intro_call_transcript_url summary notes
  `),
  lead_notes: columns(`id lead_id body author created_at`),
  lead_tasks: columns(`
    id lead_id title notes due_at remind_at block_time status mission_id created_at completed_at
  `),
  missions: columns(`
    id title notes kind priority status due_at scheduled_start scheduled_end all_day
    is_recurring rrule linked_company_id linked_account_id source ics_uid ics_sequence
    invite_sent_at reminder_lead_min created_at completed_at dismissed_at
  `),
  pipeline_stages: columns(`id name sort_order color archived created_at`),
  scoring_weights: columns(`signal_type strength weight`),
  score_snapshots: columns(`
    id taken_at label company_id netsuite_internal_id tam_score codex_score
    oldgold_score score_adjust_note prior_values
  `),
  import_batches: columns(`id filename row_count enriched_count uploaded_at`),
  discovery_coverage: columns(`source slice_key last_run_at run_count results_count`),
  fmcsa_snapshots: columns(`dot_number legal_name nbr_power_unit driver_total captured_at`),
  agent_messages: columns(`
    id created_at from_agent to_agent kind subject body ref thread_id read_at
  `),
  agent_tasks: columns(`
    id agent title state done total note detail started_at heartbeat_at finished_at
  `),
  stanley_logs: columns(`id user_text reply plan created_at`),
  territory_config: columns(`
    id subindustries industries naics_codes states revenue_min revenue_max employees_min
    employees_max updated_at
  `),
  schema_migrations: columns(`name`),
} as const);

export type ReadableTable = keyof typeof READABLE_SCALAR_COLUMNS;

const TABLES = Object.freeze(Object.keys(READABLE_SCALAR_COLUMNS) as ReadableTable[]);
const TABLE_SET = new Set<string>(TABLES);
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function readableTables(): readonly ReadableTable[] {
  return TABLES;
}

export function isReadableTable(value: string): value is ReadableTable {
  return TABLE_SET.has(value);
}

export type SafeSelectResult =
  | { ok: true; select: string }
  | { ok: false; error: string };

/** Accept only top-level allowlisted scalar column names. */
export function safeScalarSelect(table: ReadableTable, raw: string | null): SafeSelectResult {
  const allowedColumns = READABLE_SCALAR_COLUMNS[table];
  if (raw == null || raw.trim() === "*") {
    return { ok: true, select: allowedColumns.join(",") };
  }

  const requested = raw.split(",").map((field) => field.trim());
  if (!requested.length || requested.some((field) => !field || !IDENTIFIER.test(field))) {
    return {
      ok: false,
      error: "select accepts only comma-separated scalar column names; relationships, aliases, spreads, casts, JSON paths, and expressions are not allowed",
    };
  }

  const allowed = new Set<string>(allowedColumns);
  const unknown = requested.filter((field) => !allowed.has(field));
  if (unknown.length) {
    return { ok: false, error: `select contains unreadable column(s): ${[...new Set(unknown)].join(", ")}` };
  }

  return { ok: true, select: [...new Set(requested)].join(",") };
}
