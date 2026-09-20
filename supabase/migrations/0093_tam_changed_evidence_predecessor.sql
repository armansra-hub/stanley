-- Select the latest completed canonical successor when a final was carried forward.
begin;
create or replace function public.tam_record_changed_document(p_document uuid,p_observed_capture timestamptz default null) returns uuid
language plpgsql security definer set search_path=public,pg_temp as $$
declare d lead_documents; previous tam_regrade_records; company_uuid uuid; company_count integer; receipt uuid;
begin
 select * into d from lead_documents where id=p_document;
 if not found or d.doc_type<>'record_text' or d.sha256 !~ '^[0-9a-f]{64}$'
   or encode(sha256(convert_to(d.body,'UTF8')),'hex')<>d.sha256 then return null; end if;
 -- A new browser observation may have the same bytes as an older stored
 -- document (a CRM edit reverted). Keep that document immutable, but use the
 -- fresh full-record observation time for this evidence-change receipt.
 if p_observed_capture is not null then d.captured_at:=p_observed_capture; end if;
 select count(*),min(c.id::text)::uuid into company_count,company_uuid from companies c where c.netsuite_internal_id=d.netsuite_internal_id
  and c.lists @> array['netsuite_tam'] and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));
 if company_count<>1 or (d.company_id is not null and d.company_id<>company_uuid) then return null; end if;
 select r.* into previous from tam_regrade_records r join tam_regrade_runs canonical_run on canonical_run.id=r.run_id where r.netsuite_internal_id=d.netsuite_internal_id and r.company_id=company_uuid
   and r.is_current and r.grade_status='published' and r.validation_status='passed' and r.checkpoint_seed_id is not null
   and canonical_run.completed_checkpoint_seed_id=r.checkpoint_seed_id
   and canonical_run.status in ('grading','paused','complete')
   and r.grade_provenance->>'recordTextSha256' ~ '^[0-9a-f]{64}$'
   -- Carried unchanged finals intentionally retain their original publication
   -- date. The newest completed canonical run owns their next change receipt.
   order by canonical_run.created_at desc,r.published_at desc nulls last,canonical_run.id desc limit 1;
 if not found or previous.grade_provenance->>'recordTextSha256'=d.sha256 then return null; end if;
 -- An older upload is not evidence of a new CRM change. Missing capture dates
 -- are retained as receipts but cannot be admitted without local fresh capture.
 if d.captured_at is not null and previous.grade_provenance->>'capturedAt' is not null
   and d.captured_at <= (previous.grade_provenance->>'capturedAt')::timestamptz then return null; end if;
 insert into tam_evidence_change_receipts(company_id,netsuite_internal_id,predecessor_run_id,predecessor_seed_id,
  predecessor_provenance_sha256,previous_record_text_sha256,document_id,record_text_sha256,captured_at)
 values(company_uuid,d.netsuite_internal_id,previous.run_id,previous.checkpoint_seed_id,previous.grade_provenance_sha256,
  previous.grade_provenance->>'recordTextSha256',d.id,d.sha256,d.captured_at) on conflict do nothing returning id into receipt;
 if receipt is not null then
  insert into tam_regrade_events(run_id,actor_key,kind,netsuite_internal_id,summary,metadata)
  values(previous.run_id,'source-ingestion','evidence.full_record_changed',d.netsuite_internal_id,'New full-record text differs from completed grading evidence; canonical successor admission required.',
   jsonb_build_object('changeReceiptId',receipt,'documentId',d.id,'oldRecordTextSha256',previous.grade_provenance->>'recordTextSha256','recordTextSha256',d.sha256));
 else select id into receipt from tam_evidence_change_receipts where company_id=company_uuid and predecessor_provenance_sha256=previous.grade_provenance_sha256 and record_text_sha256=d.sha256;
 end if;
 return receipt;
end $$;
notify pgrst,'reload schema';
commit;
