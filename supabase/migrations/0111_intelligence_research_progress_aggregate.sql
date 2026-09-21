-- Preserve 0110's exact scope and counts while aggregating each evidence/job
-- relation once. Per-observation job probes have no observation_id index and
-- per-account correlated CTE probes become expensive at current corpus size.
-- Only narrow flags/counts cross materialization boundaries, never source text,
-- native answer packets or the complete directed-research result JSON.
begin;
create or replace function public.intelligence_research_progress()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with eligible as materialized (
    select id from companies where lists @> array['netsuite_tam']::text[]
      and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$'
  ), observations as materialized (
    select o.id,o.company_id,
      o.is_current and not o.feedback_excluded as current_evidence,
      o.attributes is not null as interpreted
    from intelligence_observations o join eligible c on c.id=o.company_id
  ), job_facts as materialized (
    select j.observation_id,
      count(*) filter(where j.status in ('queued','running')) as pending,
      bool_or(j.status='failed') as failed,
      count(*) filter(where j.created_at>=now()-interval '1 hour') as new_last_hour,
      count(*) filter(where j.status='complete' and j.finished_at>=now()-interval '1 hour') as complete_last_hour
    from intelligence_jobs j join observations o on o.id=j.observation_id
    where j.kind='interpret' group by j.observation_id
  ), evidence_facts as materialized (
    select o.company_id,
      bool_or(o.current_evidence) as captured,
      bool_or(o.current_evidence and o.interpreted) as interpreted,
      coalesce(sum(j.pending) filter(where o.current_evidence),0) as pending,
      bool_or(o.current_evidence and (coalesce(j.failed,false)
        or (not o.interpreted and coalesce(j.pending,0)=0))) as blocked,
      coalesce(sum(j.new_last_hour),0) as new_last_hour,
      coalesce(sum(j.complete_last_hour),0) as complete_last_hour
    from observations o left join job_facts j on j.observation_id=o.id group by o.company_id
  ), accounts as (
    select c.id,coalesce(e.captured,false) as captured,coalesce(e.interpreted,false) as interpreted,
      coalesce(e.pending,0) as pending,coalesce(e.blocked,false) as blocked,
      coalesce(e.new_last_hour,0) as new_last_hour,coalesce(e.complete_last_hour,0) as complete_last_hour,
      j.status,j.due_at,j.result->>'outcome' as outcome
    from eligible c left join evidence_facts e on e.company_id=c.id
      left join intelligence_directed_research_jobs j on j.company_id=c.id
  ) select jsonb_build_object('available',true,'asOf',now(),'scope','eligible_tam',
    'accounts',jsonb_build_object('total',count(*),'withEvidence',count(*) filter(where captured),
      'withInterpretation',count(*) filter(where interpreted),
      'caughtUp',count(*) filter(where status='complete' and outcome='caught_up' and pending=0 and not blocked),
      'awaitingInterpretation',count(*) filter(where pending>0),
      'blockedInterpretation',count(*) filter(where blocked),
      'researchReady',count(*) filter(where status='queued' and due_at<=now()),
      'researchRunning',count(*) filter(where status='running'),
      'sourceRetry',count(*) filter(where status='queued' and outcome='waiting_retry'),
      'researchFailed',count(*) filter(where status='failed'),
      'discoveryCheckDue',count(*) filter(where status='complete' and due_at<=now())),
    'processing',jsonb_build_object('pending',coalesce(sum(pending),0)),
    'lastHour',jsonb_build_object('newInterpretationJobs',coalesce(sum(new_last_hour),0),
      'completedInterpretationJobs',coalesce(sum(complete_last_hour),0)),
    'policy',jsonb_build_object('discoveryContinues',true,'paidWorkRequiresUnansweredInput',true,
      'caughtUpMeans','Known due sources read and their interpretations finished. Unknown business facts may remain; new sources and scheduled discovery wake research.'))
  from accounts;
$$;
revoke all on function public.intelligence_research_progress() from public,anon,authenticated;
grant execute on function public.intelligence_research_progress() to service_role;
notify pgrst,'reload schema';
commit;
