-- Cache only the read-only 50% exploration projection. Raw native answers,
-- supported-topic cache, feed publication and TAM grading are unchanged.
-- Existing rows are backfilled in explicit small transactions after deployment;
-- adding this nullable column does not rewrite or interpret the source table.
begin;
create function public.intelligence_exploratory_topics(p_attributes jsonb,p_text text)
returns text[] language plpgsql immutable security definer set search_path=public,pg_temp as $$
declare ref jsonb; attribution jsonb; source_length integer; topics text[]:='{}';
begin
 if p_attributes is null or p_text is null then return topics; end if;
 for ref in select * from intelligence_native_topic_references(p_attributes) loop
  attribution:=case when ref ? 'companyRelationship' or ref ? 'companyRelevance' then ref else p_attributes end;
  if attribution->>'companyRelationship' is distinct from 'direct'
    or jsonb_typeof(ref->'probability') is distinct from 'number'
    or jsonb_typeof(attribution->'companyRelevance') is distinct from 'number'
    or jsonb_typeof(ref->'start') is distinct from 'number'
    or jsonb_typeof(ref->'end') is distinct from 'number' then continue; end if;
  if (ref->>'probability')::numeric not between .5 and 1
    or (attribution->>'companyRelevance')::numeric not between .5 and 1
    or (ref->>'start')::numeric<0
    or (ref->>'start')::numeric<>trunc((ref->>'start')::numeric)
    or (ref->>'end')::numeric<>trunc((ref->>'end')::numeric)
    or (ref->>'end')::numeric<=(ref->>'start')::numeric then continue; end if;
  if source_length is null then
   source_length:=length(p_text)+length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'));
  end if;
  if (ref->>'end')::numeric<=source_length then topics:=array_append(topics,ref->>'topic'); end if;
 end loop;
 return array(select distinct topic from unnest(topics) topic order by topic);
end $$;

alter table public.intelligence_observations add column cached_exploratory_topics text[];
create function public.intelligence_refresh_exploratory_topics()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 new.cached_exploratory_topics:=public.intelligence_exploratory_topics(new.attributes,new.evidence_text);
 return new;
end $$;
create trigger intelligence_refresh_exploratory_topics
 before insert or update of attributes,evidence_text on public.intelligence_observations
 for each row execute function public.intelligence_refresh_exploratory_topics();
create index intelligence_exploratory_cache_pending on public.intelligence_observations(id)
 where cached_exploratory_topics is null;
create index intelligence_cached_exploratory_topics on public.intelligence_observations
 using gin(cached_exploratory_topics) where is_current and not feedback_excluded;

create function public.intelligence_backfill_exploration_cache(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare updated_count integer; remaining_count bigint;
begin
 if p_limit is null or p_limit<1 or p_limit>500 then raise exception 'Invalid exploration cache batch size'; end if;
 with selected as materialized (
  select id from public.intelligence_observations where cached_exploratory_topics is null
  order by id limit p_limit for update skip locked
 ) update public.intelligence_observations o
 set cached_exploratory_topics=public.intelligence_exploratory_topics(o.attributes,o.evidence_text)
 from selected where o.id=selected.id;
 get diagnostics updated_count=row_count;
 select count(*) into remaining_count from public.intelligence_observations where cached_exploratory_topics is null;
 return jsonb_build_object('updated',updated_count,'remaining',remaining_count,'complete',remaining_count=0);
end $$;

create or replace function public.intelligence_topic_explore(p_topics text[],p_after uuid default null,p_limit integer default 8,p_mode text default 'all')
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_limit integer; v_topics text[];
begin
 if p_topics is null or cardinality(p_topics)>8 or array_position(p_topics,null) is not null
  or not p_topics <@ array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting','project_delivery','project_financials','unbilled_work']::text[]
  or p_mode is null or p_mode not in ('all','any') or p_limit is null or p_limit<1 or p_limit>12 then raise exception 'Invalid operating topic query'; end if;
 select coalesce(array_agg(distinct topic order by topic),'{}'::text[]) into v_topics from unnest(p_topics) topic;
 v_limit:=p_limit;
 return (
 with eligible as materialized (
  select id,name,domain,subindustry,netsuite_internal_id from companies
  where lists @> array['netsuite_tam']::text[] and status is distinct from 'removed_from_tam'
   and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[]))) and netsuite_internal_id ~ '^[0-9]+$'
 ), observations as materialized (
  -- Counts and matching touch compact stored arrays, never every raw body or
  -- packet JSON. Complete raw evidence is fetched only for the shown sources.
  -- The temporary fallback preserves every existing answer during backfill.
  -- Once complete, COALESCE never evaluates the source/JSON helper on reads.
  select o.id,o.company_id,o.observed_at,
   coalesce(o.cached_exploratory_topics,public.intelligence_exploratory_topics(o.attributes,o.evidence_text)) as topics,
   o.attributes is not null as interpreted
  from intelligence_observations o join eligible c on c.id=o.company_id where o.is_current and not o.feedback_excluded
 ), account_topics as materialized (
  select distinct o.company_id,topic from observations o cross join lateral unnest(o.topics) topic
 ), matched as materialized (
  select company_id from account_topics where topic=any(v_topics)
  group by company_id having p_mode='any' or count(*)=cardinality(v_topics)
 ), page as materialized (
  select c.* from eligible c join matched m on m.company_id=c.id
  where p_after is null or c.id>p_after order by c.id limit v_limit+1
 ), shown as materialized (select * from page order by id limit v_limit), account_rows as (
  select c.id,jsonb_build_object('companyId',c.id,'name',c.name,'domain',c.domain,'subindustry',c.subindustry,'internalId',c.netsuite_internal_id,
   'coverage',(select jsonb_build_object('observations',count(*),'interpreted',count(*) filter(where interpreted)) from observations where company_id=c.id),
   'observations',coalesce((select jsonb_agg(jsonb_build_object('id',o.id,'source_url',o.source_url,'title',o.title,'source_kind',o.source_kind,
     'event_date',o.event_date,'observed_at',o.observed_at,'evidence_text',o.evidence_text,'attributes',o.attributes) order by o.observed_at desc,o.id)
    from intelligence_observations o where o.id in (
     select distinct on (topic) supporting.id from observations supporting cross join lateral unnest(v_topics) topic
     where supporting.company_id=c.id and topic=any(supporting.topics) order by topic,supporting.observed_at desc,supporting.id desc
    )),'[]'::jsonb)) value from shown c
 ) select jsonb_build_object('enabled',true,'topics',v_topics,'mode',p_mode,'visibility','explore',
  'topicCounts',(select jsonb_object_agg(known.topic,coalesce(t.accounts,0))
   from unnest(array['multi_entity','project_billing','recurring_revenue','inventory','multi_location','systems_project','acquisition_integration','government_work','project_delivery','project_financials','unbilled_work','close_reporting','financial_controls','cash_working_capital','finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights','fleet_costs','investor_reporting']::text[]) known(topic)
   left join (select topic,count(*) accounts from account_topics group by topic) t on t.topic=known.topic),
  'accounts',coalesce((select jsonb_agg(value order by id) from account_rows),'[]'::jsonb),
  'hasMore',(select count(*)>v_limit from page),
  'nextCursor',case when (select count(*)>v_limit from page) then (select id from shown order by id desc limit 1) else null end,
  'coverage',jsonb_build_object('tamAccounts',(select count(*) from eligible),
   'accountsWithTopicEvidence',(select count(distinct company_id) from account_topics),
   'currentObservations',(select count(*) from observations),'interpretedObservations',(select count(*) from observations where interpreted),
   'matchingAccounts',(select count(*) from matched),
   'accountsWithNoInterpretedEvidence',(select count(*) from eligible)-(select count(distinct company_id) from observations where interpreted),
   'accountsWithoutSelectedEvidence',case when cardinality(v_topics)>0 then (select count(*) from eligible)-(select count(*) from (select distinct company_id from account_topics where topic=any(v_topics)) selected) else null end,
   'asOf',now(),'cacheOnly',true))
 );
end $$;
revoke all on function public.intelligence_exploratory_topics(jsonb,text) from public,anon,authenticated;
grant execute on function public.intelligence_exploratory_topics(jsonb,text) to service_role;
revoke all on function public.intelligence_refresh_exploratory_topics() from public,anon,authenticated;
revoke all on function public.intelligence_backfill_exploration_cache(integer) from public,anon,authenticated;
grant execute on function public.intelligence_backfill_exploration_cache(integer) to service_role;
notify pgrst,'reload schema';
commit;
