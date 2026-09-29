-- The live plan scanned/decompressed queued result JSON before it knew whether
-- each job belonged to news/TAL. Keep source selection scalar and inspect paid
-- continuation state only on each exact locked candidate. No jobs are rewritten.
begin;
create index if not exists intelligence_codex_news_observation_queue
 on public.intelligence_jobs(observation_id,priority desc,created_at,id)
 where kind='interpret' and status='queued' and codex_news_request_id is null;

do $migration$
declare definition text; pattern text; replacement text; matches integer;
begin
 definition:=pg_get_functiondef('public.intelligence_codex_news(text,jsonb)'::regprocedure);
 if position('codex-news-scalar-candidates-v1' in definition)>0 then return; end if;
 pattern:='select\s+q\.\*\s+into\s+j\s+from\s+intelligence_jobs\s+q\s+join\s+intelligence_observations\s+n[^;]*for\s+update\s+of\s+q\s+skip\s+locked;\s*if\s+not\s+found\s+then\s+return\s+null;\s*end\s+if;';
 select count(*) into matches from regexp_matches(definition,pattern,'gi');
 if matches<>1 then raise exception 'Expected exactly one original Codex claim query'; end if;
 select count(*) into matches from regexp_matches(definition,'bound_trigger\s+uuid;','gi');
 if matches<>1 then raise exception 'Unexpected Codex claim declaration'; end if;
 definition:=regexp_replace(definition,'bound_trigger\s+uuid;','bound_trigger uuid; candidate_id uuid; selected_job uuid;','i');
 replacement:=$body$
 -- codex-news-scalar-candidates-v1: never sort or filter all paid result bodies.
 for candidate_id in
  with eligible_news as materialized (
   select n.id from companies co join intelligence_observations n on n.company_id=co.id
   where co.tal_claimed is true and not ('tam_duplicate'=any(coalesce(co.lists,'{}'::text[])))
    and n.source_kind='news' and n.is_current and not n.feedback_excluded
  )
  select q.id from eligible_news n join intelligence_jobs q on q.observation_id=n.id
   where q.kind='interpret' and q.status='queued' and q.codex_news_request_id is null
    and (q.due_at<=now() or q.last_error in('budget_deferred','intelligence_disabled'))
   order by q.priority desc,q.created_at,q.id for update of q skip locked
 loop
  select * into j from intelligence_jobs where id=candidate_id;
  if coalesce(j.result->'pendingRequest','null'::jsonb)='null'::jsonb then selected_job:=j.id; exit; end if;
 end loop;
 if selected_job is null then
  for candidate_id in
   with eligible_news as materialized (
    select n.id from companies co join intelligence_observations n on n.company_id=co.id
    where co.tal_claimed is not true and co.lists @> array['netsuite_tam']::text[]
     and co.status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(co.lists,'{}'::text[])))
     and n.source_kind='news' and n.is_current and not n.feedback_excluded
   )
   select q.id from eligible_news n join intelligence_jobs q on q.observation_id=n.id
    where q.kind='interpret' and q.status='queued' and q.codex_news_request_id is null
     and (q.due_at<=now() or q.last_error in('budget_deferred','intelligence_disabled'))
    order by q.priority desc,q.created_at,q.id for update of q skip locked
  loop
   select * into j from intelligence_jobs where id=candidate_id;
   if coalesce(j.result->'pendingRequest','null'::jsonb)='null'::jsonb then selected_job:=j.id; exit; end if;
  end loop;
 end if;
 if selected_job is null then return null; end if;
$body$;
 execute regexp_replace(definition,pattern,replacement,'i');
end $migration$;
notify pgrst,'reload schema';
commit;
