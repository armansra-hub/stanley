-- Observe repeated exact bytes without rewriting their original document.
-- This preserves an A -> B -> A edit while B is still being graded.
begin;
create table public.tam_document_capture_observations (
 document_id uuid not null references lead_documents(id), captured_at timestamptz not null,
 observed_at timestamptz not null default now(), primary key(document_id,captured_at)
);
create index on public.tam_document_capture_observations(captured_at desc,observed_at desc);
alter table public.tam_document_capture_observations enable row level security;
revoke all on public.tam_document_capture_observations from public,anon,authenticated,service_role;
grant select on public.tam_document_capture_observations to service_role;

create or replace function public.tam_observe_document_captures(p_captures jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare item jsonb; document_uuid uuid; receipt_uuid uuid; captured timestamptz; changed integer:=0;
begin
 if jsonb_typeof(p_captures)<>'array' or jsonb_array_length(p_captures) not between 1 and 200 then raise exception 'bounded document observations required'; end if;
 for item in select value from jsonb_array_elements(p_captures) loop
  if item->>'docType' is distinct from 'record_text' then continue; end if;
  select id into document_uuid from lead_documents where netsuite_internal_id=item->>'internalId' and doc_type='record_text' and sha256=item->>'sha256';
  if document_uuid is null then raise exception 'observed document not stored'; end if;
  captured:=(item->>'capturedAt')::timestamptz;
  if captured is not null then
   insert into tam_document_capture_observations(document_id,captured_at) values(document_uuid,captured) on conflict do nothing;
  end if;
  receipt_uuid:=tam_record_changed_document(document_uuid,captured);
  if receipt_uuid is not null then changed:=changed+1; end if;
 end loop;
 return jsonb_build_object('observed',jsonb_array_length(p_captures),'changes',changed);
end $$;

create or replace function public.tam_changed_document_trigger() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.doc_type='record_text' and new.captured_at is not null then
  insert into tam_document_capture_observations(document_id,captured_at) values(new.id,new.captured_at) on conflict do nothing;
 end if;
 perform tam_record_changed_document(new.id); return new;
end $$;

create or replace function public.tam_changed_evidence_publication() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare latest_document uuid; actual_capture timestamptz;
begin
 if new.grade_status='published' and new.validation_status='passed' then
  update tam_evidence_change_receipts set status='published',published_at=new.published_at,publication_provenance_sha256=new.grade_provenance_sha256
   where successor_run_id=new.run_id and successor_seed_id=new.checkpoint_seed_id and company_id=new.company_id
   and netsuite_internal_id=new.netsuite_internal_id and record_text_sha256=new.grade_provenance->>'recordTextSha256'
   and successor_pdf_sha256=new.pdf_sha256 and status='admitted';
  select evidence.id,evidence.captured_at into latest_document,actual_capture from (
   select d.id,o.captured_at,o.observed_at from tam_document_capture_observations o join lead_documents d on d.id=o.document_id
    where d.netsuite_internal_id=new.netsuite_internal_id and d.doc_type='record_text'
   union all
   select d.id,d.captured_at,d.created_at from lead_documents d where d.netsuite_internal_id=new.netsuite_internal_id and d.doc_type='record_text'
  ) evidence order by evidence.captured_at desc nulls last,evidence.observed_at desc,evidence.id desc limit 1;
  if latest_document is not null then perform tam_record_changed_document(latest_document,actual_capture); end if;
 end if;
 return new;
end $$;
notify pgrst,'reload schema';
commit;
