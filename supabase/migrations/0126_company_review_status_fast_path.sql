-- A human visibility decision must not re-hash saved research or wake Jev.
-- Save bulk review decisions and their durable receipt in one transaction.
begin;

create or replace function public.intelligence_catalog_invalidate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare company uuid;
begin
 if tg_table_name='companies' then
   -- The evidence identity includes membership eligibility, not reviewed /
   -- dismissed / exported visibility. Check before touching the research rows.
   if tg_op='UPDATE' and row(new.name,new.domain,new.subindustry,new.ns_industry,new.city,new.state,
       new.status is distinct from 'removed_from_tam',new.lists,new.netsuite_internal_id)
     is not distinct from row(old.name,old.domain,old.subindustry,old.ns_industry,old.city,old.state,
       old.status is distinct from 'removed_from_tam',old.lists,old.netsuite_internal_id) then return new; end if;
   company:=new.id;
 else company:=new.company_id; end if;
 if not exists(select 1 from intelligence_directed_research_jobs where company_id=company and catalog_requested_version is not null) then return new; end if;
 if tg_op='UPDATE' and tg_table_name<>'companies' then
   if row(new.content_hash,new.source_url,new.title,new.event_date,new.is_current,new.feedback_excluded,new.metadata->'textTruncated',new.metadata->'sourceTruncated')
     is not distinct from row(old.content_hash,old.source_url,old.title,old.event_date,old.is_current,old.feedback_excluded,old.metadata->'textTruncated',old.metadata->'sourceTruncated') then return new; end if;
 end if;
 if exists(select 1 from intelligence_catalog_accounts a where a.company_id=company
   and a.evidence_key=intelligence_catalog_evidence(company)->>'evidenceKey') then return new; end if;
 update intelligence_catalog_accounts set status='stale',result_updated_at=now() where company_id=company;
 update intelligence_catalog_facets set status='stale' where company_id=company;
 update intelligence_directed_research_jobs set status=case when status='running' and lease_until>now() then status else 'queued' end,
   due_at=now(),wake_reason='catalog_evidence_changed',finished_at=null,last_error=null where company_id=company;
 return new;
end $$;

create function public.companies_set_review_status(p_ids uuid[],p_status text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='8s' set lock_timeout='2s' as $$
declare affected integer; decided_at timestamptz;
begin
 if p_ids is null or cardinality(p_ids) not between 1 and 10000 or array_position(p_ids,null) is not null
   or p_status is null or p_status not in ('new','reviewed','dismissed')
   or cardinality(p_ids)<>(select count(distinct id) from unnest(p_ids) id) then
   raise exception 'invalid_review_decision' using errcode='22023';
 end if;
 -- Lock in a stable order and reject an incomplete set before any status or
 -- receipt is changed. Large selections stay in the POST body, not a URL.
 perform id from companies where id=any(p_ids) order by id for update;
 get diagnostics affected=row_count;
 if affected<>cardinality(p_ids) then raise exception 'review_company_not_found' using errcode='P0002'; end if;
 decided_at:=clock_timestamp();
 update companies set status=p_status,last_updated_at=decided_at,
   exported_at=case when p_status='new' then null else exported_at end,
   trigger_reviewed_through=case when p_status='new' then null else decided_at end
 where id=any(p_ids);
 insert into app_events(ts,module,kind,summary,entity_type,meta)
 values(decided_at,'headhunter','lead.status_changed',format('Marked %s lead%s %s',affected,case when affected=1 then '' else 's' end,p_status),
   'companies',jsonb_build_object('count',affected,'status',p_status,'ids',to_jsonb(p_ids)));
 return jsonb_build_object('ok',true,'count',affected,'ids',to_jsonb(p_ids),'status',p_status);
end $$;

revoke all on function public.companies_set_review_status(uuid[],text),public.intelligence_catalog_invalidate() from public,anon,authenticated;
grant execute on function public.companies_set_review_status(uuid[],text),public.intelligence_catalog_invalidate() to service_role;
notify pgrst,'reload schema';
commit;
