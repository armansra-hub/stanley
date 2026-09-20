-- Add a current spend-rate window so cumulative history does not hide changes.
-- Keeps existing invoice-estimate and unknown-reservation semantics unchanged.
begin;

create or replace function public.intelligence_jev_cost_metrics()
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  with bounds as (
    select date_trunc('month',now() at time zone 'UTC') at time zone 'UTC' month_start
  ), periods as (
    select 'month'::text period, month_start starts_at from bounds
    union all select 'last24h', now()-interval '24 hours'
    union all select 'last1h', now()-interval '1 hour'
  ), ledger as materialized (
    select s.*,
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
  ), aggregates as (
    select p.period,d.dimension,d.key,
      count(s.id) requests,
      count(s.id) filter(where s.state='settled' and s.input_tokens is not null) known_requests,
      coalesce(sum(s.input_tokens) filter(where s.state='settled' and s.input_tokens is not null),0) tokens,
      coalesce(sum(s.charged_usd) filter(where s.state='settled' and s.input_tokens is not null),0) estimated,
      count(s.id) filter(where s.state='settled' and s.input_tokens is null) unknown_requests,
      coalesce(sum(coalesce(s.charged_usd,s.reserved_usd)) filter(where s.state='settled' and s.input_tokens is null),0) unknown_reserve,
      count(s.id) filter(where s.state='reserved') in_flight_requests,
      coalesce(sum(s.reserved_usd) filter(where s.state='reserved'),0) in_flight_reserve
    from periods p left join ledger s on s.created_at>=p.starts_at
    cross join lateral (values
      ('total'::text,'total'::text),('purpose',s.purpose_key),('activity',s.activity_key),('workload',s.workload_key)
    ) d(dimension,key)
    group by p.period,d.dimension,d.key
  ), rendered as (
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
notify pgrst,'reload schema';
commit;
