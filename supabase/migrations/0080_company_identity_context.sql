-- Bounded read-only business identity context. No grade/membership writes and
-- no private record body is placed in a public observation or trigger.
begin;
create or replace function public.company_identity_source_context(p_company_id uuid)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
  select jsonb_build_object(
    'record', (select jsonb_build_object('id',d.id,'header',left(d.body,6000),'capturedAt',d.captured_at)
      from lead_documents d where d.netsuite_internal_id=c.netsuite_internal_id
      and (d.company_id is null or d.company_id=c.id) and d.doc_type='record_text'
      order by d.captured_at desc nulls last,d.id desc limit 1),
    'websites', coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'url',x.source_url,
      'capturedAt',x.observed_at,'identity',x.metadata->'companyIdentity')) from (
        select id,source_url,observed_at,metadata from intelligence_observations
        where company_id=c.id and is_current and not feedback_excluded
        and source_kind='website' and jsonb_typeof(metadata->'companyIdentity')='object'
        order by observed_at desc,id desc limit 8
      ) x),'[]'::jsonb))
  from companies c where c.id=p_company_id and c.status<>'removed_from_tam'
    and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));
$$;
revoke all on function public.company_identity_source_context(uuid) from public,anon,authenticated;
grant execute on function public.company_identity_source_context(uuid) to service_role;
notify pgrst,'reload schema';
commit;
