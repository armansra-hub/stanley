-- Unchanged collector sightings must not schedule another paid saved answer.
-- Preserve native results/provenance and still revise work for changed evidence.
begin;
alter table public.intelligence_account_question_jobs add column evidence_key text;

create function public.intelligence_account_question_evidence_key(p_view uuid,p_company uuid)
returns text language sql stable security definer set search_path=public,pg_temp as $$
 select encode(sha256(convert_to(jsonb_build_object('version','account-question-evidence-v1',
  'company',c.name,'question',v.question,'sources',coalesce((
    select jsonb_agg(jsonb_build_array(o.id,o.content_hash,o.source_url,o.title,o.event_date) order by o.id)
    from intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded
  ),'[]'::jsonb))::text,'UTF8')),'hex')
 from companies c cross join intelligence_views v where c.id=p_company and v.id=p_view;
$$;

-- Adopt demonstrably current completed work without reinterpreting it. Existing
-- evidenceHash is sha256(JSON.stringify([question, sorted observation IDs])).
update intelligence_account_question_jobs j set evidence_key=intelligence_account_question_evidence_key(j.view_id,j.company_id)
from intelligence_account_question_matches m,intelligence_views v
where j.view_id=m.view_id and j.company_id=m.company_id and v.id=j.view_id
 and j.status='complete' and m.result->>'question'=v.question
 and m.result->>'evidenceHash'=encode(sha256(convert_to('['||to_json(v.question)::text||',['||coalesce((
   select string_agg(to_json(o.id::text)::text,',' order by o.id) from intelligence_observations o
   where o.company_id=j.company_id and o.is_current and not o.feedback_excluded
 ),'')||']]','UTF8')),'hex');

create or replace function public.intelligence_account_question_enqueue(p_view uuid,p_company uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare next_key text;
begin
 next_key:=intelligence_account_question_evidence_key(p_view,p_company);
 if next_key is null then return; end if;
 insert into intelligence_account_question_jobs(view_id,company_id,evidence_key) values(p_view,p_company,next_key)
 on conflict(view_id,company_id) do update set evidence_key=excluded.evidence_key,
  revision=intelligence_account_question_jobs.revision+1,
  status=case when intelligence_account_question_jobs.status='running' and intelligence_account_question_jobs.lease_until>now() then 'running' else 'queued' end,
  due_at=now(),updated_at=now()
 where intelligence_account_question_jobs.evidence_key is distinct from excluded.evidence_key
  or (intelligence_account_question_jobs.status='complete' and not exists(
    select 1 from intelligence_account_question_matches m where m.view_id=p_view and m.company_id=p_company));
end $$;

create or replace function public.intelligence_account_question_observation_changed()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v record;
begin
 if tg_op='UPDATE' then
  if new.is_current is not distinct from old.is_current
   and new.feedback_excluded is not distinct from old.feedback_excluded
   and new.content_hash is not distinct from old.content_hash
   and new.source_url is not distinct from old.source_url
   and new.title is not distinct from old.title
   and new.event_date is not distinct from old.event_date then return new; end if;
  if new.feedback_excluded and not old.feedback_excluded then
   delete from intelligence_account_question_matches where company_id=new.company_id;
  end if;
 end if;
 for v in select id from intelligence_views where active loop
  perform intelligence_account_question_enqueue(v.id,new.company_id);
 end loop;
 return new;
end $$;
drop trigger intelligence_account_question_observation_changed on public.intelligence_observations;
create trigger intelligence_account_question_observation_changed
 after insert or update of is_current,feedback_excluded,content_hash,source_url,title,event_date on public.intelligence_observations
 for each row execute function public.intelligence_account_question_observation_changed();

revoke all on function public.intelligence_account_question_evidence_key(uuid,uuid) from public,anon,authenticated;
grant execute on function public.intelligence_account_question_evidence_key(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
