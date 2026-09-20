-- Avoid a source-ingest/pending-repair lock-order inversion.
begin;
create or replace function public.federal_identity_finish_pending_match(p_company uuid,p_lease uuid,p_before jsonb,p_decision jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare m company_government_matches; saved jsonb;
begin
 if not exists(select 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now()) then raise exception 'identity lease lost'; end if;
 -- Same lock order as ordinary source ingestion: advisory key, then row.
 perform pg_advisory_xact_lock(hashtextextended('government_identity_match:'||p_company::text||':'||(p_before->>'government_entity_id'),0));
 select * into m from company_government_matches where id=(p_before->>'id')::uuid and company_id=p_company for update;
 if not found or to_jsonb(m) is distinct from p_before or m.match_status<>'pending' then return jsonb_build_object('outcome','stale'); end if;
 if p_decision->>'status'='verified' and (not public.federal_identity_supported_direct(p_decision) or not public.federal_identity_sources_current(p_company,p_decision)) then raise exception 'unsupported pending repair'; end if;
 saved:=public.government_identity_save_match(p_company,m.government_entity_id,p_decision)->'match';
 insert into federal_identity_remediation_receipts(match_id,company_id,policy_version,before_image,after_image,outcome,evidence)
 values(m.id,p_company,'jev-recipient-v1',to_jsonb(m),saved,coalesce(p_decision#>>'{evidence,jevIdentity,outcome}',p_decision->>'status'),p_decision->'evidence');
 return jsonb_build_object('outcome','recorded','matchStatus',saved->>'match_status');
end $$;
notify pgrst,'reload schema';
commit;
