-- Match equality filters and the unchanged pending-record dispatch order.
-- Full index also supports generic parameter plans; no predicate, INCLUDE or uniqueness.
CREATE INDEX tam_regrade_records_dispatch_idx ON public.tam_regrade_records USING btree (run_id, is_current, pdf_status, grade_status, source_page ASC NULLS LAST, source_row ASC NULLS LAST, netsuite_internal_id ASC);
