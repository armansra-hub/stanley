-- Select one eligible link rather than loading/truncating an account's entire
-- match set. Existing company lease, receipt cooldown and repair CAS remain.
begin;
create function public.federal_identity_next_repair_match(p_company uuid,p_lease uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare selected company_government_matches; pending boolean;
begin
 if not exists(select 1 from federal_identity_jobs where company_id=p_company and lease_token=p_lease and lease_expires_at>now()) then raise exception 'identity lease lost'; end if;
 select m.* into selected from company_government_matches m
 where m.company_id=p_company and m.match_status='verified' and federal_identity_match_needs_repair(m)
  and not exists(select 1 from federal_identity_remediation_receipts r where r.match_id=m.id and r.created_at>now()-interval '7 days')
 order by m.id limit 1;
 if not found then
  return jsonb_build_object('match',null,'pending',false,'hasWeakMatches',exists(
   select 1 from company_government_matches m where m.company_id=p_company and m.match_status='verified' and federal_identity_match_needs_repair(m)));
 end if;
 pending:=exists(select 1 from company_government_matches m
  where m.company_id=p_company and m.id<>selected.id and m.match_status='verified' and federal_identity_match_needs_repair(m)
   and not exists(select 1 from federal_identity_remediation_receipts r where r.match_id=m.id and r.created_at>now()-interval '7 days'));
 return jsonb_build_object('match',to_jsonb(selected),'pending',pending,'hasWeakMatches',true);
end $$;
revoke all on function public.federal_identity_next_repair_match(uuid,uuid) from public,anon,authenticated;
grant execute on function public.federal_identity_next_repair_match(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
