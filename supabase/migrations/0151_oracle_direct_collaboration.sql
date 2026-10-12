-- Admit evidenced direct commercial collaboration without forcing a legal
-- partnership role. Existing original/read/identity/date/reviewer gates remain.
-- No operational rows, provider policy, source checkpoints or queues change.
begin;
do $migration$
declare
 definition text := pg_get_functiondef('public.intelligence_codex_news(text,jsonb)'::regprocedure);
 old_guard text := $old$  -- oracle-partnership-reviewed-v1: all original source/read/reviewer gates remain.
  if t->>'type'='oracle_partnership' and (
   a->'attributes'->>'signalType' is distinct from 'oracle_partnership'
   or a->'attributes'->>'companyRelationship' is distinct from 'direct'
   or a->'attributes'->>'companyRole' is distinct from 'partner'
   or a->'attributes'->>'contentClass' is distinct from 'actual_company_development'
   or coalesce(t->'evidence'->>'excerpt','') !~* '\moracle(partnernetwork)?\M'
   or coalesce(t->'evidence'->>'excerpt','') !~* '\m(oraclepartnernetwork|partner(s|ed|ing|ship|ships|network)?|collaborat(e|es|ed|ion)|alliance|joint[[:space:]]+(initiative|agreement|venture))\M'
  ) then raise exception 'Oracle partnership evidence required'; end if;$old$;
 new_guard text := $new$  -- oracle-direct-collaboration-reviewed-v2: wording is necessary, not semantic proof.
  if t->>'type'='oracle_partnership' and (
   a->'attributes'->>'signalType' is distinct from 'oracle_partnership'
   or a->'attributes'->>'companyRelationship' is distinct from 'direct'
   or coalesce(a->'attributes'->>'companyRole','') not in ('partner','service_provider')
   or a->'attributes'->>'contentClass' is distinct from 'actual_company_development'
   or coalesce(t->'evidence'->>'excerpt','') !~* '\moracle(partnernetwork)?\M'
   or (coalesce(t->'evidence'->>'excerpt','') !~* '\m(oraclepartnernetwork|partner(s|ed|ing|ship|ships|network)?|collaborat(e|es|ed|ion)|alliance|joint[[:space:]]+(initiative|agreement|venture))\M'
    and coalesce(t->'evidence'->>'excerpt','') !~* '\mwork(s|ed|ing)?[[:space:]]+(directly[[:space:]]+)?with[[:space:]]+oracle([[:space:]]+corporation)?[[:space:]]+(to|on|towards?)[[:space:]]+[^.!?\r\n]{8,240}')
   or (a->'attributes'->>'companyRole'='service_provider'
    and coalesce(t->'evidence'->>'excerpt','') !~* '\mwork(s|ed|ing)?[[:space:]]+(directly[[:space:]]+)?with[[:space:]]+oracle([[:space:]]+corporation)?[[:space:]]+(to|on|towards?)[[:space:]]+[^.!?\r\n]{8,240}')
  ) then raise exception 'Oracle partnership evidence required'; end if;$new$;
begin
 if position(new_guard in definition)>0 and position(old_guard in definition)=0 then return; end if;
 if array_length(string_to_array(definition,old_guard),1)<>2 then
  raise exception 'Unexpected Oracle reviewed publisher definition; inspect before applying';
 end if;
 execute replace(definition,old_guard,new_guard);
 if position(new_guard in pg_get_functiondef('public.intelligence_codex_news(text,jsonb)'::regprocedure))=0 then
  raise exception 'Oracle collaboration publisher readback mismatch';
 end if;
end;
$migration$;
notify pgrst,'reload schema';
commit;
