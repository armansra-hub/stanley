-- Reporting only. Preserve counters, scope and financial semantics exactly.
-- Reduce cost aggregation fan-out and ignore research job history that cannot
-- contribute to any displayed metric. No work dispatch or provider calls.
-- Supabase REST inherits an 8s authenticator timeout; these two reporting RPCs
-- alone get a bounded 15s ceiling, without changing any global/role setting.
begin;
create index if not exists intelligence_spend_jev_attribution_start
  on public.intelligence_spend(created_at)
  where category='jev' and nullif(purpose,'') is not null;
create or replace function public.intelligence_jev_cost_metrics()
returns jsonb language sql stable security definer set search_path=public,pg_temp set statement_timeout='15s' as $$
  with bounds as (
    select date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' month_start
  ), periods as (
    select 'month'::text period, month_start starts_at from bounds
    union all select 'last24h', now()-interval '24 hours'
    union all select 'last1h', now()-interval '1 hour'
  ), source_rows as (
    select s.state,s.input_tokens,s.charged_usd,s.reserved_usd,
      s.created_at>=(select month_start from bounds) as in_month,
      s.created_at>=now()-interval '24 hours' as in_day,
      s.created_at>=now()-interval '1 hour' as in_hour,
      coalesce(nullif(s.purpose,''),'historical_unattributed') purpose_key,
      coalesce(nullif(s.workload,''),'historical_unattributed') workload_key,
      case
        when s.purpose='public_interpretation' then case s.source_kind
          when 'website' then 'website_research' when 'news' then 'news_research'
          when 'job' then 'hiring_research' when 'government' then 'government_research'
          else 'public_research_other' end
        when nullif(s.purpose,'') is null then 'historical_unattributed'
        else s.purpose end activity_key
    from intelligence_spend s
    where s.category='jev'
      and s.month >= date_trunc('month',least((select month_start from bounds),now()-interval '24 hours') at time zone 'UTC')::date
      and s.created_at >= least((select month_start from bounds),now()-interval '24 hours')
  ), ledger as materialized (
    -- Aggregate each reservation once before expanding the tiny grouped result
    -- into periods and display dimensions. Boolean window membership preserves
    -- overlapping windows, including the first day of a new UTC month.
    select in_month,in_day,in_hour,purpose_key,activity_key,workload_key,
      count(*) requests,
      count(*) filter(where state='settled' and input_tokens is not null) known_requests,
      coalesce(sum(input_tokens) filter(where state='settled' and input_tokens is not null),0) tokens,
      coalesce(sum(charged_usd) filter(where state='settled' and input_tokens is not null),0) estimated,
      count(*) filter(where state='settled' and input_tokens is null) unknown_requests,
      coalesce(sum(coalesce(charged_usd,reserved_usd)) filter(where state='settled' and input_tokens is null),0) unknown_reserve,
      count(*) filter(where state='reserved') in_flight_requests,
      coalesce(sum(reserved_usd) filter(where state='reserved'),0) in_flight_reserve
    from source_rows group by in_month,in_day,in_hour,purpose_key,activity_key,workload_key
  ), aggregates as (
    select p.period,d.dimension,d.key,
      coalesce(sum(s.requests),0) requests,
      coalesce(sum(s.known_requests),0) known_requests,
      coalesce(sum(s.tokens),0) tokens,coalesce(sum(s.estimated),0) estimated,
      coalesce(sum(s.unknown_requests),0) unknown_requests,
      coalesce(sum(s.unknown_reserve),0) unknown_reserve,
      coalesce(sum(s.in_flight_requests),0) in_flight_requests,
      coalesce(sum(s.in_flight_reserve),0) in_flight_reserve
    from periods p left join ledger s on case p.period
      when 'month' then s.in_month when 'last24h' then s.in_day else s.in_hour end
    cross join lateral (values
      ('total'::text,'total'::text),('purpose',s.purpose_key),('activity',s.activity_key),('workload',s.workload_key)
    ) d(dimension,key)
    group by p.period,d.dimension,d.key  ), rendered as (
    select period,dimension,key,requests,jsonb_build_object(
      'requests',requests,'knownUsageRequests',known_requests,'reportedInputTokens',tokens,'estimatedUsd',estimated,
      'unknownUsageRequests',unknown_requests,'unknownUsageReserveUsd',unknown_reserve,
      'inFlightRequests',in_flight_requests,'inFlightReserveUsd',in_flight_reserve
    ) metrics from aggregates
  ), period_results as (
    select period,jsonb_build_object(
      'totals',(jsonb_agg(metrics) filter(where dimension='total'))->0,
      'byPurpose',coalesce(jsonb_agg(metrics||jsonb_build_object('key',key) order by key) filter(where dimension='purpose' and requests>0),'[]'::jsonb),
      'byActivity',coalesce(jsonb_agg(metrics||jsonb_build_object('key',key) order by key) filter(where dimension='activity' and requests>0),'[]'::jsonb),
      'byWorkload',coalesce(jsonb_agg(metrics||jsonb_build_object('key',key) order by key) filter(where dimension='workload' and requests>0),'[]'::jsonb)
    ) metrics from rendered group by period
  ) select jsonb_build_object(
    'asOf',now(),'monthStart',(select month_start from bounds),'usdPerMillionInputTokens',0.042,
    'attributionStartedAt',(select min(created_at) from intelligence_spend where category='jev' and nullif(purpose,'') is not null),
    'month',(select metrics from period_results where period='month'),
    'last24h',(select metrics from period_results where period='last24h'),
    'last1h',(select metrics from period_results where period='last1h')
  );
$$;
revoke all on function public.intelligence_jev_cost_metrics() from public,anon,authenticated;
grant execute on function public.intelligence_jev_cost_metrics() to service_role;

create or replace function public.intelligence_research_progress()
returns jsonb language sql stable security definer set search_path=public,pg_temp set statement_timeout='15s' as $$
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
    where j.kind='interpret' and (
      (o.current_evidence and j.status in ('queued','running','failed'))
      or j.created_at>=now()-interval '1 hour'
      or (j.status='complete' and j.finished_at>=now()-interval '1 hour')
    ) group by j.observation_id
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
