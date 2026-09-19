-- Measured freshness and useful-output diagnostics. No grading or membership writes.
begin;
create index intelligence_observations_interpreted_at on public.intelligence_observations(interpreted_at) where interpreted_at is not null;
create index intelligence_jobs_finished_at on public.intelligence_jobs(finished_at) where finished_at is not null;

create function public.intelligence_health()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with eligible as materialized (
    select id from companies where lists @> array['netsuite_tam']::text[]
      and status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
      and netsuite_internal_id ~ '^[0-9]+$'
  ), observations as not materialized (
    select o.* from intelligence_observations o join eligible c on c.id=o.company_id
  ), recent as materialized (
    select * from observations where interpreted_at>=now()-interval '24 hours'
  ), published as materialized (
    select t.* from triggers t join eligible c on c.id=t.company_id
    where t.metadata ? 'jevFinding' and t.detected_at>=now()-interval '24 hours'
      and coalesce((t.metadata->>'intelligenceFeedbackExcluded')::boolean,false)=false
      and not (coalesce(t.metadata,'{}'::jsonb) ? 'quarantine')
  ) select jsonb_build_object(
    'asOf',now(),
    'queue',jsonb_build_object(
      'due',(select count(*) from intelligence_jobs where status='queued' and due_at<=now()),
      'deferred',(select count(*) from intelligence_jobs where status='queued' and due_at>now()),
      'oldestDueAt',(select min(created_at) from intelligence_jobs where status='queued' and due_at<=now()),
      'expiredLeases',(select count(*) from intelligence_jobs where status='running' and lease_until<now()),
      'completedLastHour',(select count(*) from intelligence_jobs where status='complete' and finished_at>=now()-interval '1 hour'),
      'completedLast24h',(select count(*) from intelligence_jobs where status='complete' and finished_at>=now()-interval '24 hours')),
    'freshness',jsonb_build_object(
      'capturedLast24h',(select count(*) from observations where observed_at>=now()-interval '24 hours'),
      'interpretedLast24h',(select count(*) from recent),
      'medianCaptureToInterpretSeconds',(select percentile_cont(.5) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from recent),
      'p95CaptureToInterpretSeconds',(select percentile_cont(.95) within group(order by greatest(0,extract(epoch from interpreted_at-observed_at))) from recent),
      'lastCapturedAt',(select max(observed_at) from observations),
      'lastInterpretedAt',(select max(interpreted_at) from observations)),
    'coverage',jsonb_build_object(
      'tamAccounts',(select count(*) from eligible),
      'accountsWithEvidence',(select count(distinct company_id) from observations where is_current and not feedback_excluded),
      'accountsInterpreted',(select count(distinct company_id) from observations where is_current and not feedback_excluded and attributes is not null),
      'websiteSuccess48h',(select count(distinct s.company_id) from intelligence_source_state s join eligible c on c.id=s.company_id
        where source_key='website' and last_success_at>=now()-interval '48 hours'),
      'atsSuccess48h',(select count(distinct s.company_id) from intelligence_source_state s join eligible c on c.id=s.company_id
        where source_key like 'ats:%' and last_success_at>=now()-interval '48 hours')),
    'yield',jsonb_build_object(
      'jevTriggersLast24h',(select count(*) from published),
      'distinctTriggeredAccountsLast24h',(select count(distinct company_id) from published),
      'usefulFeedbackLast24h',(select count(*) from intelligence_feedback where reason='useful' and updated_at>=now()-interval '24 hours'),
      'medianCaptureToCardSeconds',(select percentile_cont(.5) within group(order by greatest(0,extract(epoch from p.detected_at-o.observed_at)))
        from published p join observations o on o.id::text=p.metadata->'jevFinding'->>'observationId'),
      'modelCostLast24h',(select coalesce(sum(coalesce(charged_usd,reserved_usd)),0) from intelligence_spend where created_at>=now()-interval '24 hours'))
  );
$$;
revoke all on function public.intelligence_health() from public,anon,authenticated;
grant execute on function public.intelligence_health() to service_role;

create function public.intelligence_lookalikes(p_company uuid,p_offset integer default 0,p_limit integer default 8)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if p_company is null or p_offset is null or p_offset<0 or p_offset>100000 or p_limit is null or p_limit<1 or p_limit>12 then
    raise exception 'Invalid lookalike request';
  end if;
  return (
    with eligible as materialized (
      select id,name,domain,subindustry from companies where lists @> array['netsuite_tam']::text[]
        and status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
        and netsuite_internal_id ~ '^[0-9]+$'
    ), evidence as not materialized (
      select o.* from intelligence_observations o join eligible c on c.id=o.company_id
      where o.is_current and not o.feedback_excluded and cardinality(o.cached_operating_topics)>0
    ), account_topics as materialized (
      select company_id,array_agg(distinct topic order by topic) topics from evidence
      cross join lateral unnest(cached_operating_topics) topic group by company_id
    ), seed as (
      select coalesce((select topics from account_topics where company_id=p_company),'{}'::text[]) topics
    ), similarities as (
      select a.*,array(select unnest(a.topics) intersect select unnest(s.topics)) shared,
        cardinality(s.topics) seed_count from account_topics a cross join seed s where a.company_id<>p_company and a.topics&&s.topics
    ), ranked as materialized (
      select s.*,cardinality(shared)::numeric/nullif(cardinality(topics)+seed_count-cardinality(shared),0) similarity
      from similarities s where cardinality(shared)>=least(2,seed_count)
    ), page as (
      select r.*,c.name,c.domain,c.subindustry from ranked r join eligible c on c.id=r.company_id
      order by similarity desc,cardinality(shared) desc,c.id offset p_offset limit p_limit+1
    ), shown as (
      select * from page order by similarity desc,cardinality(shared) desc,company_id limit p_limit
    ) select jsonb_build_object('companyId',p_company,'seedTopics',(select topics from seed),
      'matchingAccounts',(select count(*) from ranked),'hasMore',(select count(*)>p_limit from page),
      'nextOffset',case when (select count(*)>p_limit from page) then p_offset+p_limit else null end,
      'accounts',coalesce((select jsonb_agg(jsonb_build_object('companyId',s.company_id,'name',s.name,'domain',s.domain,
        'subindustry',s.subindustry,'sharedTopics',s.shared,'topics',s.topics,'similarity',s.similarity,
        'sources',coalesce((select jsonb_agg(row_to_json(ref)) from (
          select e.id as "observationId",e.source_url as url,e.title,e.event_date as "eventDate",e.observed_at as "observedAt",
            e.cached_operating_topics as topics,left(e.attributes->>'evidenceExcerpt',600) as excerpt
          from evidence e where e.company_id=s.company_id and e.cached_operating_topics&&s.shared
          order by e.observed_at desc,e.id limit 4
        ) ref),'[]'::jsonb)) order by s.similarity desc,cardinality(s.shared) desc,s.company_id) from shown s),'[]'::jsonb),
      'asOf',now(),'note','Similarity describes shared sourced operating traits, not buying intent or TAM grade. Unmatched traits can be unknown.'
    )
  );
end $$;
revoke all on function public.intelligence_lookalikes(uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.intelligence_lookalikes(uuid,integer,integer) to service_role;
notify pgrst,'reload schema';
commit;
