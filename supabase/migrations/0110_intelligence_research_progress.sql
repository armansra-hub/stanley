begin;
create function public.intelligence_research_progress()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with eligible as materialized (
    select id from companies where lists @> array['netsuite_tam']::text[]
      and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$'
  ), accounts as materialized (
    select c.id,
      exists(select 1 from intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded) captured,
      exists(select 1 from intelligence_observations o where o.company_id=c.id and o.is_current and not o.feedback_excluded and o.attributes is not null) interpreted,
      j.status,j.due_at,j.result,j.caught_up_at
    from eligible c left join intelligence_directed_research_jobs j on j.company_id=c.id
  ), pending as materialized (
    select j.company_id,count(*) pending from (
      select o.company_id from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
      join eligible c on c.id=o.company_id where j.kind='interpret' and j.status in ('queued','running')
        and o.is_current and not o.feedback_excluded
    ) j group by j.company_id
  ), blocked as materialized (
    select distinct o.company_id from intelligence_observations o join eligible c on c.id=o.company_id
    where o.is_current and not o.feedback_excluded and (
      exists(select 1 from intelligence_jobs j where j.observation_id=o.id and j.kind='interpret' and j.status='failed')
      or (o.attributes is null and not exists(select 1 from intelligence_jobs j where j.observation_id=o.id
        and j.kind='interpret' and j.status in ('queued','running'))))
  ) select jsonb_build_object('available',true,'asOf',now(),'scope','eligible_tam',
    'accounts',(select jsonb_build_object('total',count(*),'withEvidence',count(*) filter(where captured),
      'withInterpretation',count(*) filter(where interpreted),
      'caughtUp',count(*) filter(where status='complete' and result->>'outcome'='caught_up'
        and not exists(select 1 from pending p where p.company_id=a.id) and not exists(select 1 from blocked b where b.company_id=a.id)),
      'awaitingInterpretation',count(*) filter(where exists(select 1 from pending p where p.company_id=a.id)),
      'blockedInterpretation',count(*) filter(where exists(select 1 from blocked b where b.company_id=a.id)),
      'researchReady',count(*) filter(where status='queued' and due_at<=now()),
      'researchRunning',count(*) filter(where status='running'),
      'sourceRetry',count(*) filter(where status='queued' and result->>'outcome'='waiting_retry'),
      'researchFailed',count(*) filter(where status='failed'),
      'discoveryCheckDue',count(*) filter(where status='complete' and due_at<=now())) from accounts a),
    'processing',(select jsonb_build_object('pending',coalesce(sum(pending),0)) from pending),
    'lastHour',jsonb_build_object(
      'newInterpretationJobs',(select count(*) from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
        join eligible c on c.id=o.company_id where j.kind='interpret' and j.created_at>=now()-interval '1 hour'),
      'completedInterpretationJobs',(select count(*) from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
        join eligible c on c.id=o.company_id where j.kind='interpret' and j.status='complete' and j.finished_at>=now()-interval '1 hour')),
    'policy',jsonb_build_object('discoveryContinues',true,'paidWorkRequiresUnansweredInput',true,
      'caughtUpMeans','Known due sources read and their interpretations finished. Unknown business facts may remain; new sources and scheduled discovery wake research.'));
$$;
revoke all on function public.intelligence_research_progress() from public,anon,authenticated;
grant execute on function public.intelligence_research_progress() to service_role;
notify pgrst,'reload schema';
commit;
