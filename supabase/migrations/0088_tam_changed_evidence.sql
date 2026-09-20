-- Changed full-record receipts are canonical TAM evidence, not a grading queue.
-- Existing seeded rounds, membership, grades, claims and PDF evidence stay intact.
begin;
create table public.tam_evidence_change_receipts (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id), netsuite_internal_id text not null,
 predecessor_run_id uuid not null references tam_regrade_runs(id), predecessor_seed_id uuid not null,
 predecessor_provenance_sha256 text not null, previous_record_text_sha256 text not null,
 document_id uuid not null references lead_documents(id), record_text_sha256 text not null,
 captured_at timestamptz, observed_at timestamptz not null default now(),
 status text not null default 'observed' check (status in ('observed','admitted','published')),
 successor_run_id uuid references tam_regrade_runs(id), successor_seed_id uuid, successor_pdf_sha256 text,
 successor_evidence_index_sha256 text, admitted_at timestamptz, published_at timestamptz, publication_provenance_sha256 text,
 unique(company_id,predecessor_provenance_sha256,record_text_sha256)
);
create index on public.tam_evidence_change_receipts(netsuite_internal_id,observed_at desc);
create index on public.tam_evidence_change_receipts(status,observed_at);
alter table public.tam_evidence_change_receipts enable row level security;
revoke all on public.tam_evidence_change_receipts from public,anon,authenticated,service_role;
grant select on public.tam_evidence_change_receipts to service_role;

create function public.tam_record_changed_document(p_document uuid,p_observed_capture timestamptz default null) returns uuid
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
 select r.* into previous from tam_regrade_records r where r.netsuite_internal_id=d.netsuite_internal_id and r.company_id=company_uuid
   and r.is_current and r.grade_status='published' and r.validation_status='passed' and r.checkpoint_seed_id is not null
   and r.grade_provenance->>'recordTextSha256' ~ '^[0-9a-f]{64}$' order by r.published_at desc nulls last,r.run_id desc limit 1;
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
create function public.tam_changed_document_trigger() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin perform tam_record_changed_document(new.id); return new; end $$;
create trigger tam_changed_document after insert on public.lead_documents for each row execute function public.tam_changed_document_trigger();
create function public.tam_observe_document_captures(p_captures jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; document_uuid uuid; receipt_uuid uuid; changed integer:=0;
begin
 if jsonb_typeof(p_captures)<>'array' or jsonb_array_length(p_captures) not between 1 and 200 then raise exception 'bounded document observations required'; end if;
 for item in select value from jsonb_array_elements(p_captures) loop
  if item->>'docType' is distinct from 'record_text' then continue; end if;
  select id into document_uuid from lead_documents where netsuite_internal_id=item->>'internalId' and doc_type='record_text' and sha256=item->>'sha256';
  if document_uuid is null then raise exception 'observed document not stored'; end if;
  receipt_uuid:=tam_record_changed_document(document_uuid,(item->>'capturedAt')::timestamptz);
  if receipt_uuid is not null then changed:=changed+1; end if;
 end loop;
 return jsonb_build_object('observed',jsonb_array_length(p_captures),'changes',changed);
end $$;

create function public.tam_admit_changed_evidence(p_successor text,p_evidence_index_sha256 text,p_bindings jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare successor tam_regrade_runs; seed tam_regrade_checkpoint_seeds; binding jsonb; receipt tam_evidence_change_receipts; record tam_regrade_records; count_admitted integer:=0;
begin
 if jsonb_typeof(p_bindings)<>'array' or jsonb_array_length(p_bindings) not between 1 and 200 then raise exception 'bounded exact change bindings required'; end if;
 select * into successor from tam_regrade_runs where slug=p_successor;
 select * into seed from tam_regrade_checkpoint_seeds where id=successor.completed_checkpoint_seed_id and run_id=successor.id and status='complete';
 if seed.id is null or successor.status<>'grading' or seed.source_hashes->>'evidenceIndex' is distinct from p_evidence_index_sha256 then raise exception 'completed canonical successor evidence index required'; end if;
 for binding in select value from jsonb_array_elements(p_bindings) loop
  select * into receipt from tam_evidence_change_receipts where id=(binding->>'receiptId')::uuid for update;
  if not found or receipt.record_text_sha256 is distinct from binding->>'recordTextSha256' or receipt.captured_at is null
   or successor.mission#>>'{changedEvidence,predecessorRunId}' is distinct from receipt.predecessor_run_id::text
   or successor.mission#>>'{changedEvidence,evidenceIndexSha256}' is distinct from p_evidence_index_sha256 then raise exception 'successor change authority differs'; end if;
  select * into record from tam_regrade_records where run_id=successor.id and netsuite_internal_id=receipt.netsuite_internal_id;
  if record.company_id is distinct from receipt.company_id or not record.is_current or record.checkpoint_seed_id is distinct from seed.id
   or record.pdf_sha256 is distinct from binding->>'pdfSha256' or record.pdf_status<>'verified'
   or record.grade_status not in ('pending','reading','final','published','hold') then raise exception 'exact successor record binding differs'; end if;
  if receipt.status in ('admitted','published') then
   if receipt.successor_run_id is distinct from successor.id or receipt.successor_pdf_sha256 is distinct from record.pdf_sha256 then raise exception 'change already admitted elsewhere'; end if;
  else
   if record.grade_status<>'pending' or record.recovery_cohort<>'unrepresented' then raise exception 'changed evidence must enter canonical pending selection'; end if;
   update tam_evidence_change_receipts set status='admitted',successor_run_id=successor.id,successor_seed_id=seed.id,
    successor_pdf_sha256=record.pdf_sha256,successor_evidence_index_sha256=p_evidence_index_sha256,admitted_at=now() where id=receipt.id;
   insert into tam_regrade_events(run_id,actor_key,kind,netsuite_internal_id,summary,metadata)
   values(successor.id,'source-ingestion','evidence.successor_admitted',receipt.netsuite_internal_id,'Changed full-record evidence admitted to existing canonical pending selector.',jsonb_build_object('changeReceiptId',receipt.id,'recordTextSha256',receipt.record_text_sha256));
  end if;
  count_admitted:=count_admitted+1;
 end loop;
 return jsonb_build_object('admitted',count_admitted,'runSlug',p_successor,'seedId',seed.id);
end $$;

create function public.tam_changed_evidence_publication() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare latest_document uuid;
begin
 if new.grade_status='published' and new.validation_status='passed' then
  update tam_evidence_change_receipts set status='published',published_at=new.published_at,publication_provenance_sha256=new.grade_provenance_sha256
   where successor_run_id=new.run_id and successor_seed_id=new.checkpoint_seed_id and company_id=new.company_id
   and netsuite_internal_id=new.netsuite_internal_id and record_text_sha256=new.grade_provenance->>'recordTextSha256'
   and successor_pdf_sha256=new.pdf_sha256 and status='admitted';
  select id into latest_document from lead_documents where netsuite_internal_id=new.netsuite_internal_id and doc_type='record_text'
    order by captured_at desc nulls last,created_at desc,id desc limit 1;
  if latest_document is not null then perform tam_record_changed_document(latest_document); end if;
 end if;
 return new;
end $$;
create trigger tam_changed_evidence_published after update on public.tam_regrade_records for each row execute function public.tam_changed_evidence_publication();
revoke all on function public.tam_record_changed_document(uuid,timestamptz),public.tam_observe_document_captures(jsonb),public.tam_changed_document_trigger(),public.tam_admit_changed_evidence(text,text,jsonb),public.tam_changed_evidence_publication() from public,anon,authenticated;
grant execute on function public.tam_record_changed_document(uuid,timestamptz),public.tam_observe_document_captures(jsonb),public.tam_admit_changed_evidence(text,text,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
