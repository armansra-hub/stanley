-- Preserve native packet attribution and recover already-paid results. No model
-- dispatch, qualification grades, membership changes or federal cursor writes.
begin;

create or replace function public.intelligence_supported_topics(p_attributes jsonb,p_text text)
returns text[] language sql immutable set search_path=public,pg_temp as $$
  select coalesce(array_agg(distinct item->>'topic'),array[]::text[])
  from jsonb_array_elements(case when jsonb_typeof(p_attributes->'topicEvidence')='array'
    then p_attributes->'topicEvidence' else '[]'::jsonb end) item
  cross join lateral (select case when item ? 'companyRelationship' or item ? 'companyRelevance'
    then item else p_attributes end as attribution) a
  where a.attribution->>'companyRelationship'='direct'
    and case when jsonb_typeof(a.attribution->'companyRelevance')='number'
      then (a.attribution->>'companyRelevance')::numeric between .8 and 1 else false end
    and item->>'topic'=any(array['multi_entity','project_billing','recurring_revenue','inventory',
      'multi_location','systems_project','acquisition_integration','government_work','project_delivery',
      'project_financials','unbilled_work','close_reporting','financial_controls','cash_working_capital',
      'finance_leadership','workforce_billing','subcontractor_costs','client_profitability','media_rights',
      'fleet_costs','investor_reporting'])
    and case when jsonb_typeof(item->'probability')='number'
      then (item->>'probability')::numeric between .8 and 1 else false end
    and case when jsonb_typeof(item->'start')='number' and jsonb_typeof(item->'end')='number' then
      (item->>'start')::numeric>=0 and (item->>'start')::numeric=trunc((item->>'start')::numeric)
      and (item->>'end')::numeric=trunc((item->>'end')::numeric)
      and (item->>'end')::numeric>(item->>'start')::numeric
      and (item->>'end')::numeric <= length(p_text)+length(regexp_replace(p_text,U&'[^\+010000-\+10FFFF]','','g'))
      else false end;
$$;

-- Restore exact attribution from the original paid answers, not another model
-- pass or an inference from the unrelated representative packet.
with latest as (
  select distinct on (j.observation_id) j.observation_id,j.result
  from intelligence_jobs j join intelligence_observations o on o.id=j.observation_id
  where j.kind='interpret' and j.status='complete' and o.is_current and o.attributes is not null
    and jsonb_typeof(j.result->'parts')='array' and jsonb_array_length(j.result->'parts')>0
  order by j.observation_id,j.finished_at desc nulls last,j.id
), refs as (
  select l.observation_id,coalesce(jsonb_agg(jsonb_build_object(
    'topic',c.key,'probability',c.value,'start',p.value->'start','end',p.value->'end',
    'companyRelationship',p.value#>'{evaluation,attributes,companyRelationship}',
    'companyRelevance',p.value#>'{evaluation,attributes,companyRelevance}')) filter (where c.key is not null),'[]'::jsonb) topics
  from latest l cross join lateral jsonb_array_elements(l.result->'parts') p(value)
  left join lateral jsonb_each(case when jsonb_typeof(p.value#>'{evaluation,criteria}')='object'
    and p.value#>>'{evaluation,attributes,companyRelationship}'='direct'
    and case when jsonb_typeof(p.value#>'{evaluation,attributes,companyRelevance}')='number'
      then (p.value#>>'{evaluation,attributes,companyRelevance}')::numeric between .8 and 1 else false end
    then p.value#>'{evaluation,criteria}' else '{}'::jsonb end) c on
      case when jsonb_typeof(c.value)='number' then c.value::numeric between .8 and 1 else false end
  group by l.observation_id
)
update intelligence_observations o set attributes=jsonb_set(o.attributes,'{topicEvidence}',r.topics)
from refs r where o.id=r.observation_id and o.attributes->'topicEvidence' is distinct from r.topics;

-- A function replacement does not recompute STORED generated values by itself.
-- Touch only rows whose newly computed cache actually differs.
update intelligence_observations set attributes=attributes
where cached_operating_topics is distinct from intelligence_supported_topics(attributes,evidence_text);

-- Atomic append under the source card's row lock. Never replace an existing
-- summary, timestamp, primary Jev finding or original provenance. Each supplied
-- packet must belong to the same account and exact source (or same bound event).
create function public.intelligence_attach_trigger_finding(
  p_trigger uuid,p_company uuid,p_source_url text,p_finding jsonb,p_evidence jsonb)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare t triggers%rowtype; o intelligence_observations%rowtype; contexts jsonb; entry jsonb;
begin
  if jsonb_typeof(p_finding)<>'object' or jsonb_typeof(p_evidence)<>'object'
    or coalesce(p_finding->>'operationKey','') !~ '^[a-f0-9]{64}$'
    or octet_length(p_finding::text)>60000 or octet_length(p_evidence::text)>16000
    or p_finding->>'observationId' is distinct from p_evidence->>'observationId'
    or coalesce(p_evidence->>'observationId','') !~ '^[a-f0-9-]{36}$' then raise exception 'invalid_finding_context'; end if;
  select * into o from intelligence_observations where id=(p_evidence->>'observationId')::uuid
    and company_id=p_company and source_url=p_source_url and is_current and not feedback_excluded;
  if not found then raise exception 'finding_source_mismatch'; end if;
  select * into t from triggers where id=p_trigger and company_id=p_company for update;
  if not found then return false; end if;
  if t.source_url is distinct from p_source_url and not (
    p_finding->>'eventId' is not null and p_finding->>'eventId'=t.metadata#>>'{jevFinding,eventId}'
    and exists(select 1 from intelligence_event_observations m where m.observation_id=o.id
      and m.event_id::text=p_finding->>'eventId')) then raise exception 'finding_trigger_source_mismatch'; end if;
  if coalesce(t.metadata->>'intelligenceFeedbackExcluded','false')='true'
    or coalesce(t.metadata#>>'{stanley_quarantine,active}','false')='true' then return false; end if;
  contexts:=case when jsonb_typeof(t.metadata->'jevContextFindings')='array' then t.metadata->'jevContextFindings' else '[]'::jsonb end;
  entry:=jsonb_build_object('finding',p_finding,'evidence',p_evidence);
  if exists(select 1 from jsonb_array_elements(contexts) e where e#>>'{finding,operationKey}'=p_finding->>'operationKey') then
    if not exists(select 1 from jsonb_array_elements(contexts) e where e=entry) then raise exception 'finding_context_receipt_mismatch'; end if;
    return true;
  end if;
  -- Bounded card payload; all historical answers remain on observation/jobs.
  select coalesce(jsonb_agg(value order by ordinality),'[]'::jsonb) into contexts
    from jsonb_array_elements(contexts) with ordinality where ordinality>greatest(0,jsonb_array_length(contexts)-15);
  update triggers set metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{jevContextFindings}',contexts||jsonb_build_array(entry)) where id=p_trigger;
  return true;
end $$;
revoke all on function public.intelligence_attach_trigger_finding(uuid,uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.intelligence_attach_trigger_finding(uuid,uuid,text,jsonb,jsonb) to service_role;

-- Re-run only application routing for complete saved packet sets. The worker
-- reuses the original question contract and paid packets, reserves no Jev spend
-- for these sources, and checkpoints each publication outcome independently.
-- Activation is explicit AFTER the new Git deployment is ready. Installing the
-- schema while the previous worker still runs cannot dispatch these replays.
create function public.intelligence_queue_saved_packet_replay()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare queued integer;
begin
update intelligence_jobs j set status='queued',due_at=now(),lease_token=null,lease_until=null,
  last_error='saved_packet_routing_backfill',finished_at=null,
  result=j.result||jsonb_build_object('routingBackfill','business-services-v1')
from intelligence_observations o
where j.observation_id=o.id and j.kind='interpret' and j.status='complete' and o.is_current and not o.feedback_excluded
  and jsonb_typeof(j.result->'parts')='array' and jsonb_array_length(j.result->'parts')>0
  and not (j.result ? 'publications')
  and not exists(select 1 from jsonb_array_elements(j.result->'parts') p where p#>>'{evaluation,questionVersion}'
    not in ('stanley-evidence-v2','stanley-public-scale-v1','stanley-business-services-v1'));
get diagnostics queued = row_count;
return queued;
end $$;
revoke all on function public.intelligence_queue_saved_packet_replay() from public,anon,authenticated;
grant execute on function public.intelligence_queue_saved_packet_replay() to service_role;

commit;
