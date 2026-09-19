-- Cover every input of the unchanged 17-counter status aggregate.
-- Full index: records_total and removed counts include non-current records.
CREATE INDEX tam_regrade_records_status_covering_idx ON public.tam_regrade_records USING btree (run_id) INCLUDE (is_current, membership_status, pdf_status, grade_status, claim_expires_at, recovery_cohort);
