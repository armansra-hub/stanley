-- Count displayed contract events, while retaining inactive and merged source receipts.
-- Exact JSON types mirror isPublishableTriggerEvidence: boolean true or string merge target.
begin;
create or replace function public.intelligence_health()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with eligible as materialized (
    select id from companies where lists @> array['netsuite_tam']::text[]
      and status is distinct from 'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$'
  ), all_observations as not materialized (
    select o.* from intelligence_observations o join eligible c on c.id=o.company_id
  ), first_captured as materialized (
    select company_id,min(observed_at) first_observed_at from all_observations group by company_id
  ), observations as not materialized (
    select o.* from all_observations o where o.is_current and not o.feedback_excluded
  ), jobs as materialized (
    select j.* from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id join eligible c on c.id=o.company_id
  ), recent as materialized (
    select * from observations where interpreted_at>=now()-interval '24 hours'
  ), cohort_start as (
    select date_trunc('hour',max(observed_at)) start from observations
  ), cohort as materialized (
    select o.* from observations o cross join cohort_start s where o.observed_at>=s.start and o.observed_at<s.start+interval '1 hour'
  ), published as materialized (
    select t.* from triggers t join eligible c on c.id=t.company_id
    where t.detected_at>=now()-interval '24 hours'
      and coalesce((t.metadata->>'intelligenceFeedbackExcluded')::boolean,false)=false
      and not (coalesce(t.metadata,'{}'::jsonb) ? 'quarantine')
      and coalesce(t.metadata#>>'{stanley_quarantine,active}','false')<>'true'
      and t.metadata->'contractTimingInactive' is distinct from 'true'::jsonb
      and jsonb_typeof(t.metadata->'contractEventMergedInto') is distinct from 'string'
  ), jev_published as materialized (
    select * from published where metadata ? 'jevFinding'
      or (jsonb_typeof(metadata->'jevContextFindings')='array' and metadata->'jevContextFindings'<>'[]'::jsonb)
  ), story_jobs as materialized (
    select j.* from intelligence_story_jobs j join eligible c on c.id=j.company_id
  ), research_jobs as materialized (
    select j.* from intelligence_directed_research_jobs j join eligible c on c.id=j.company_id
  ) select jsonb_build_object(
    'asOf',now(),'scope','eligible_tam','spendScope','global',
    'queue',jsonb_build_object(
      'due',(select count(*) from jobs where status='queued' and due_at<=now()),
      'deferred',(select count(*) from jobs where status='queued' and due_at>now()),
      'running',(select count(*) from jobs where status='running'),
      'failed',(select count(*) from jobs where status='failed'),
      'oldestDueAt',(select min(due_at) from jobs where status='queued' and due_at<=now()),
      'expiredLeases',(select count(*) from jobs where status='running' and lease_until<now()),
      'completedLastHour',(select count(*) from jobs where status='complete' and finished_at>=now()-interval '1 hour'),
      'completedLast24h',(select count(*) from jobs where status='complete' and finished_at>=now()-interval '24 hours')),
    'work',jsonb_build_object(
      'stories',jsonb_build_object('queued',(select count(*) from story_jobs where status='queued'),'running',(select count(*) from story_jobs where status='running'),'failed',(select count(*) from story_jobs where status='failed')),
      'research',jsonb_build_object('queued',(select count(*) from research_jobs where status='queued'),'running',(select count(*) from research_jobs where status='running'),'failed',(select count(*) from research_jobs where status='failed'))),
    'freshness',jsonb_build_object(
      'capturedLast24h',(select count(*) from observations where observed_at>=now()-interval '24 hours'),
      'interpretedLast24h',(select count(*) from recent),
      'medianCaptureToInterpretSeconds',(select percentile_cont(.5) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from recent),
      'p95CaptureToInterpretSeconds',(select percentile_cont(.95) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from recent),
      'lastCapturedAt',(select max(observed_at) from observations),
      'lastInterpretedAt',(select max(interpreted_at) from observations),
      'latestCohort',jsonb_build_object(
        'start',(select start from cohort_start),'end',(select start+interval '1 hour' from cohort_start),
        'captured',(select count(*) from cohort),'interpreted',(select count(*) from cohort where interpreted_at is not null),
        'pending',(select count(*) from cohort where interpreted_at is null),
        'medianSeconds',(select percentile_cont(.5) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from cohort where interpreted_at is not null),
        'p95Seconds',(select percentile_cont(.95) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from cohort where interpreted_at is not null))),
    'coverage',jsonb_build_object(
      'tamAccounts',(select count(*) from eligible),
      'accountsWithEvidence',(select count(distinct company_id) from observations),
      'accountsFirstCapturedLastHour',(select count(*) from first_captured where first_observed_at>=now()-interval '1 hour'),
      'accountsFirstCapturedLast24h',(select count(*) from first_captured where first_observed_at>=now()-interval '24 hours'),
      'sourceChangedLastHour',(select count(distinct (o.company_id,o.source_key)) from all_observations o
        where o.observed_at>=now()-interval '1 hour' and exists(select 1 from all_observations prior
          where prior.company_id=o.company_id and prior.source_key=o.source_key and prior.observed_at<o.observed_at)),
      'accountsInterpreted',(select count(distinct company_id) from observations where attributes is not null),
      'accountsWithTopics',(select count(distinct company_id) from observations where cardinality(cached_operating_topics)>0),
      'accountsWithStoredStory',(select count(distinct s.company_id) from intelligence_account_stories s join eligible c on c.id=s.company_id),
      'accountsWithHiringBaseline',(select count(distinct b.company_id) from intelligence_ats_boards b join eligible c on c.id=b.company_id where b.last_complete_at is not null),
      'websiteSuccess48h',(select count(distinct s.company_id) from intelligence_source_state s join eligible c on c.id=s.company_id where source_key='website' and last_success_at>=now()-interval '48 hours'),
      'atsSuccess48h',(select count(distinct b.company_id) from intelligence_ats_boards b join eligible c on c.id=b.company_id where b.last_complete_at>=now()-interval '48 hours')),
    'yield',jsonb_build_object(
      'allTriggersLast24h',(select count(*) from published),
      'allTriggeredAccountsLast24h',(select count(distinct company_id) from published),
      'jevTriggersLast24h',(select count(*) from jev_published),
      'distinctTriggeredAccountsLast24h',(select count(distinct company_id) from jev_published),
      'usefulFeedbackLast24h',(select count(*) from intelligence_feedback f join eligible c on c.id=f.company_id where reason='useful' and updated_at>=now()-interval '24 hours'),
      'medianCaptureToCardSeconds',(select percentile_cont(.5) within group(order by greatest(0,extract(epoch from p.detected_at-o.observed_at)))
        from jev_published p join observations o on o.id::text=p.metadata->'jevFinding'->>'observationId'),
      'modelCostLast24h',(select coalesce(sum(coalesce(charged_usd,reserved_usd)),0) from intelligence_spend where created_at>=now()-interval '24 hours'))
  );
$$;
revoke all on function public.intelligence_health() from public,anon,authenticated;
grant execute on function public.intelligence_health() to service_role;
notify pgrst,'reload schema';
commit;
