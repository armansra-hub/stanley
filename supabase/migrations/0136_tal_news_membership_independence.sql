-- TAL is its own exact membership. Leaving the current TAM must not prevent
-- a still-claimed canonical TAL account from capturing news or reading its
-- existing identity evidence. Duplicate identity history remains excluded.
-- No company, membership, observation, job, or paid-worker state is rewritten.
begin;

do $tal_news_membership$
declare
  definition text;
  old_guard text;
  new_guard text;
begin
  -- Patch only the admission guard in the deployed observation function.
  -- Preserve its source/version identity, reuse, provenance, and job fences.
  select pg_get_functiondef('public.intelligence_observe(uuid,text,text,text,text,text,text,timestamp with time zone,timestamp with time zone,jsonb,jsonb,text)'::regprocedure)
    into definition;
  old_guard := $observe_old$select subindustry into v_subindustry from companies where id=p_company and status <> 'removed_from_tam';$observe_old$;
  new_guard := $observe_new$select subindustry into v_subindustry from companies where id=p_company
    and not ('tam_duplicate'=any(coalesce(lists,'{}'::text[])))
        and (status <> 'removed_from_tam' or tal_claimed);$observe_new$;
  if (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)=1
    and position(new_guard in definition)=0 then
    execute replace(definition,old_guard,new_guard);
  elsif (length(definition)-length(replace(definition,new_guard,'')))/length(new_guard)=1
    and position(old_guard in definition)=0 then
    null; -- Exact correction already applied; do not rewrite the function.
  else
    raise exception 'Unexpected intelligence_observe admission guard; review required';
  end if;

  -- Same eligibility for bounded account identity reads. The exact CRM header,
  -- website evidence, and sourced alias queries remain byte-for-byte unchanged.
  select pg_get_functiondef('public.company_identity_source_context(uuid)'::regprocedure)
    into definition;
  old_guard := $identity_old$from companies c where c.id=p_company_id and c.status<>'removed_from_tam' and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));$identity_old$;
  new_guard := $identity_new$from companies c where c.id=p_company_id and (c.status<>'removed_from_tam' or c.tal_claimed)
           and not ('tam_duplicate'=any(coalesce(c.lists,'{}'::text[])));$identity_new$;
  if (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)=1
    and position(new_guard in definition)=0 then
    execute replace(definition,old_guard,new_guard);
  elsif (length(definition)-length(replace(definition,new_guard,'')))/length(new_guard)=1
    and position(old_guard in definition)=0 then
    null;
  else
    raise exception 'Unexpected company_identity_source_context admission guard; review required';
  end if;
end;
$tal_news_membership$;

-- CREATE OR REPLACE retains the existing service-role-only function grants.
notify pgrst,'reload schema';
commit;
