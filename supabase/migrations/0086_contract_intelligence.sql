begin;
create table if not exists contract_intelligence_state (
 company_id uuid primary key references companies(id) on delete cascade,
 last_award_id uuid, next_due_at timestamptz not null default now(), lease_token uuid, lease_until timestamptz,
 batch_last_id uuid, batch_has_more boolean, last_completed_at timestamptz, last_error text
);
create index if not exists contract_intelligence_due on contract_intelligence_state(next_due_at);
create table if not exists contract_intelligence_deliveries (
 delivery_key text primary key, company_id uuid not null references companies(id) on delete cascade,
 federal_award_id uuid not null references federal_awards(id) on delete cascade,
 observation_id uuid not null references intelligence_observations(id), created_at timestamptz not null default now()
);
create table if not exists contract_milestones (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id) on delete cascade,
 federal_award_id uuid not null references federal_awards(id) on delete cascade,
 kind text not null check(kind in ('start','end','potential_end','ordering_end','option')), milestone_date date not null,
 label text not null, source_url text not null, evidence jsonb not null default '{}',
 created_at timestamptz not null default now(), unique(company_id,federal_award_id,kind,milestone_date)
);
create index if not exists contract_milestones_company on contract_milestones(company_id,milestone_date);
create table if not exists contract_announcement_links (
 trigger_id uuid primary key references triggers(id), company_id uuid not null references companies(id),
 federal_award_id uuid not null references federal_awards(id), method text not null,
 native_result jsonb, created_at timestamptz not null default now(), unique(company_id,federal_award_id)
);
alter table contract_intelligence_state enable row level security;
alter table contract_intelligence_deliveries enable row level security;
alter table contract_milestones enable row level security;
alter table contract_announcement_links enable row level security;
revoke all on contract_intelligence_state,contract_intelligence_deliveries,contract_milestones,contract_announcement_links from public,anon,authenticated;
grant all on contract_intelligence_state,contract_intelligence_deliveries,contract_milestones,contract_announcement_links to service_role;

create or replace function contract_intelligence_claim() returns jsonb language plpgsql security definer set search_path=public as $$
declare s contract_intelligence_state%rowtype; payload jsonb; page jsonb; last_id uuid; more boolean;
begin
 insert into contract_intelligence_state(company_id)
 select distinct m.company_id from company_government_matches m join companies c on c.id=m.company_id
 where m.match_status='verified' and c.status is distinct from 'removed_from_tam'
 and exists(select 1 from federal_awards a where a.government_entity_id=m.government_entity_id)
 on conflict do nothing;
 select q.* into s from contract_intelligence_state q join companies c on c.id=q.company_id
 where q.next_due_at<=now() and (q.lease_until is null or q.lease_until<now()) and c.status is distinct from 'removed_from_tam'
 order by q.next_due_at,q.company_id for update of q skip locked limit 1;
 if not found then return null; end if;
 select coalesce(jsonb_agg(x.obj order by x.id),'[]'),count(*)>20 into page,more from (
 select a.id,to_jsonb(a) obj from federal_awards a where (s.last_award_id is null or a.id>s.last_award_id)
 and exists(select 1 from company_government_matches m where m.company_id=s.company_id and m.government_entity_id=a.government_entity_id and m.match_status='verified')
 order by a.id limit 21) x;
 select coalesce(jsonb_agg(value order by ordinality),'[]') into page from jsonb_array_elements(page) with ordinality where ordinality<=20;
 select (value->>'id')::uuid into last_id from jsonb_array_elements(page) with ordinality order by ordinality desc limit 1;
 update contract_intelligence_state set lease_token=gen_random_uuid(),lease_until=now()+interval '240 seconds',batch_last_id=last_id,batch_has_more=more
 where company_id=s.company_id returning * into s;
 select jsonb_build_object('company',jsonb_build_object('id',c.id,'name',c.name,'domain',c.domain,'netsuite_internal_id',c.netsuite_internal_id),
 'lease_token',s.lease_token,'awards',page,'recipients',(select coalesce(jsonb_object_agg(e.id,e.legal_name),'{}') from government_entities e
 join company_government_matches m on m.government_entity_id=e.id where m.company_id=c.id and m.match_status='verified')) into payload from companies c where c.id=s.company_id;
 return payload;
end $$;

create or replace function contract_intelligence_award_done(p_company uuid,p_lease uuid,p_award uuid) returns boolean language plpgsql security definer set search_path=public as $$
begin
 update contract_intelligence_state set last_award_id=p_award where company_id=p_company and lease_token=p_lease and lease_until>now()
 and (last_award_id is null or last_award_id<=p_award) and p_award<=batch_last_id;
 return found;
end $$;

create or replace function contract_intelligence_finish(p_company uuid,p_lease uuid,p_error text) returns boolean language plpgsql security definer set search_path=public as $$
declare s contract_intelligence_state%rowtype; complete boolean;
begin
 select * into s from contract_intelligence_state where company_id=p_company and lease_token=p_lease and lease_until>now() for update;
 if not found then return false; end if;
 complete:=p_error is null and (s.batch_last_id is null or s.last_award_id=s.batch_last_id) and not s.batch_has_more;
 update contract_intelligence_state set lease_token=null,lease_until=null,last_error=p_error,
 last_award_id=case when complete then null else last_award_id end,
 next_due_at=now()+case when p_error is not null then interval '15 minutes' when complete then interval '6 hours' else interval '0 seconds' end,
 last_completed_at=case when complete then now() else last_completed_at end where company_id=p_company;
 return true;
end $$;

create or replace function contract_announcement_link(p_company uuid,p_trigger uuid,p_award uuid,p_method text,p_native jsonb default null)
returns boolean language plpgsql security definer set search_path=public as $$
declare a federal_awards%rowtype; t triggers%rowtype; canonical uuid;
begin
 if p_method not in ('exact_award_identifier','jev_source_correspondence') then raise exception 'invalid_link_method'; end if;
 perform 1 from companies where id=p_company for update;
 select * into a from federal_awards where id=p_award;
 if not found or not exists(select 1 from company_government_matches where company_id=p_company and government_entity_id=a.government_entity_id and match_status='verified') then return false; end if;
 select * into t from triggers where id=p_trigger and company_id=p_company and type='government_announcement' for update;
 if not found then return false; end if;
 insert into contract_announcement_links(trigger_id,company_id,federal_award_id,method,native_result) values(p_trigger,p_company,p_award,p_method,p_native)
 on conflict do nothing;
 if not exists(select 1 from contract_announcement_links where trigger_id=p_trigger and federal_award_id=p_award) then
  -- Another attributed announcement already owns this award. Preserve the new
  -- correspondence on its source receipt and collapse only this duplicate card.
  if exists(select 1 from contract_announcement_links where trigger_id=p_trigger) then return false; end if;
  select trigger_id into canonical from contract_announcement_links where company_id=p_company and federal_award_id=p_award;
  if canonical is null then return false; end if;
  update triggers set metadata=coalesce(metadata,'{}')||jsonb_build_object('officialAward',jsonb_build_object('id',a.id,'identifier',a.award_id,
   'sourceUrl',a.source_url,'method',p_method,'linkedAt',now(),'rawJev',p_native),'contractEventMergedInto',canonical,
   'contractOriginalStrength',coalesce(metadata->'contractOriginalStrength',to_jsonb(strength))),strength=0 where id=p_trigger;
  return true;
 end if;
 update triggers set metadata=coalesce(metadata,'{}')||jsonb_build_object('officialAward',jsonb_build_object('id',a.id,'identifier',a.award_id,
 'sourceUrl',a.source_url,'method',p_method,'linkedAt',now(),'rawJev',p_native)) where id=p_trigger;
 -- Retain all source-owned trigger rows and their original strength as receipts.
 -- One linked event is displayed; history remains inspectable.
 update triggers set metadata=coalesce(metadata,'{}')||jsonb_build_object('contractEventMergedInto',p_trigger,'contractOriginalStrength',strength),strength=0
 where company_id=p_company and id<>p_trigger and type in ('federal_award','federal_new_award','sam_award_notice')
 and (metadata->>'generatedAwardId'=a.generated_award_id or metadata->>'federalAwardId'=a.id::text
 or dedupe_key='usaspending:award:'||a.generated_award_id)
 and not coalesce(metadata,'{}') ? 'contractEventMergedInto';
 return true;
end $$;

create or replace function contract_linked_trigger(p_company uuid,p_generated text) returns uuid language sql stable security definer set search_path=public as $$
 select l.trigger_id from contract_announcement_links l join federal_awards a on a.id=l.federal_award_id
 join company_government_matches m on m.company_id=l.company_id and m.government_entity_id=a.government_entity_id and m.match_status='verified'
 where l.company_id=p_company and a.generated_award_id=p_generated limit 1
$$;
revoke all on function contract_intelligence_claim(),contract_intelligence_award_done(uuid,uuid,uuid),contract_intelligence_finish(uuid,uuid,text),contract_announcement_link(uuid,uuid,uuid,text,jsonb),contract_linked_trigger(uuid,text) from public,anon,authenticated;
grant execute on function contract_intelligence_claim(),contract_intelligence_award_done(uuid,uuid,uuid),contract_intelligence_finish(uuid,uuid,text),contract_announcement_link(uuid,uuid,uuid,text,jsonb),contract_linked_trigger(uuid,text) to service_role;
-- One active source-date reminder stage. Older windows and amended dates remain
-- receipts, with their original strength retained; only timing cards are affected.
create function contract_timing_current(p_company uuid,p_metadata jsonb,p_award jsonb)
returns boolean language plpgsql stable security definer set search_path=public as $$
declare kind text:=p_metadata->>'milestoneKind'; fact text; days integer; stage integer; known boolean;
begin
 if not exists(select 1 from company_government_matches where company_id=p_company
  and government_entity_id=(p_award->>'government_entity_id')::uuid and match_status='verified') then return false; end if;
 fact:=case kind when 'start' then p_award->>'start_date' when 'end' then p_award->>'end_date'
  when 'potential_end' then p_award->>'potential_end_date' when 'ordering_end' then p_award#>>'{evidence,orderingEndDate}' else null end;
 if kind='option' then
  select exists(select 1 from jsonb_array_elements(case when jsonb_typeof(p_award#>'{evidence,optionDates}')='array'
    then p_award#>'{evidence,optionDates}' else '[]' end) o where left(o->>'date',10)=p_metadata->>'milestoneDate'
    and o->>'sourceUrl'=p_metadata->>'milestoneSourceUrl') into known;
  if not known then return false; end if; fact:=p_metadata->>'milestoneDate';
 end if;
 if kind='potential_end' and left(fact,10)=left(p_award->>'end_date',10) then return false; end if;
 if fact is null or left(fact,10) is distinct from p_metadata->>'milestoneDate' then return false; end if;
 days:=left(fact,10)::date-current_date;
 if days<0 or days>180 then return false; end if;
 stage:=case when days<=7 then 7 when days<=30 then 30 when days<=90 then 90 else 180 end;
 return coalesce(stage::text=p_metadata->>'reminderWindowDays',false);
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then return false;
end $$;
create function contract_timing_refresh(p_company uuid,p_award uuid)
returns void language plpgsql security definer set search_path=public as $$
declare a jsonb;
begin
 select to_jsonb(f) into a from federal_awards f where f.id=p_award;
 update triggers set metadata=coalesce(metadata,'{}')||jsonb_build_object('contractTimingInactive',true,
   'contractTimingInactiveReason','source_date_identity_or_window_changed','contractTimingOriginalStrength',
   coalesce(metadata->'contractTimingOriginalStrength',to_jsonb(strength))),strength=0
 where company_id=p_company and type='contract_timing' and metadata->>'federalAwardId'=p_award::text
   and not contract_timing_current(p_company,metadata,a) and coalesce(metadata->>'contractTimingInactive','false')<>'true';
 update triggers set metadata=(metadata-'contractTimingInactiveReason')||jsonb_build_object('contractTimingInactive',false),
   strength=coalesce((metadata->>'contractTimingOriginalStrength')::integer,strength)
 where company_id=p_company and type='contract_timing' and metadata->>'federalAwardId'=p_award::text
   and contract_timing_current(p_company,metadata,a) and metadata->>'contractTimingInactive'='true';
end $$;
create function contract_timing_sync(p_company uuid,p_lease uuid,p_award uuid)
returns boolean language plpgsql security definer set search_path=public as $$
begin
 if not exists(select 1 from contract_intelligence_state where company_id=p_company and lease_token=p_lease and lease_until>now()) then return false; end if;
 perform contract_timing_refresh(p_company,p_award);return true;
end $$;
create function contract_timing_insert_guard()
returns trigger language plpgsql security definer set search_path=public as $$
declare a jsonb;
begin
 if new.type<>'contract_timing' then return new; end if;
 -- Lock the official row before insertion: an amendment either precedes this
 -- check or follows insertion and suppresses its obsolete timing card atomically.
 select to_jsonb(f) into a from federal_awards f where f.id=(new.metadata->>'federalAwardId')::uuid for share;
 if not contract_timing_current(new.company_id,new.metadata,a) then
  new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('contractTimingInactive',true,
   'contractTimingInactiveReason','source_date_identity_or_window_changed','contractTimingOriginalStrength',new.strength);
  new.strength:=0;
 end if;return new;
end $$;
create trigger contract_timing_insert_guard before insert on triggers for each row execute function contract_timing_insert_guard();
create function contract_timing_award_changed()
returns trigger language plpgsql security definer set search_path=public as $$
declare c record;
begin
 for c in select distinct company_id from company_government_matches where government_entity_id=new.government_entity_id loop
  perform contract_timing_refresh(c.company_id,new.id);
  insert into contract_intelligence_state(company_id) values(c.company_id)
   on conflict(company_id) do update set next_due_at=now();
 end loop;return new;
end $$;
create trigger contract_timing_award_changed after update of start_date,end_date,potential_end_date,evidence on federal_awards
 for each row when (old.start_date is distinct from new.start_date or old.end_date is distinct from new.end_date
  or old.potential_end_date is distinct from new.potential_end_date or old.evidence is distinct from new.evidence)
 execute function contract_timing_award_changed();
create function contract_timing_identity_changed()
returns trigger language plpgsql security definer set search_path=public as $$
declare a record;
begin
 for a in select id from federal_awards where government_entity_id=new.government_entity_id loop
  perform contract_timing_refresh(new.company_id,a.id);
 end loop;return new;
end $$;
create trigger contract_timing_identity_changed after update of match_status on company_government_matches
 for each row when(old.match_status is distinct from new.match_status) execute function contract_timing_identity_changed();
revoke all on function contract_timing_current(uuid,jsonb,jsonb),contract_timing_refresh(uuid,uuid),contract_timing_sync(uuid,uuid,uuid),contract_timing_insert_guard(),contract_timing_award_changed(),contract_timing_identity_changed() from public,anon,authenticated;
grant execute on function contract_timing_current(uuid,jsonb,jsonb),contract_timing_refresh(uuid,uuid),contract_timing_sync(uuid,uuid,uuid),contract_timing_insert_guard(),contract_timing_award_changed(),contract_timing_identity_changed() to service_role;

commit;
