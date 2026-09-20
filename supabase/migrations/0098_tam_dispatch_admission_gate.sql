-- A default-off admission read gate, not a grading/claim lock. Only the API's
-- broad pending selector consults it; admitted work retains every existing RPC.
begin;
create table public.tam_dispatch_gates (
 run_id uuid primary key references public.tam_regrade_runs(id) on delete restrict,
 seed_id uuid not null references public.tam_regrade_checkpoint_seeds(id),
 paused boolean not null default false, revision bigint not null check(revision>0),
 operation_id uuid not null unique, actor_key text not null,
 updated_at timestamptz not null default now()
);
create table public.tam_dispatch_gate_operations (
 operation_id uuid primary key, run_id uuid not null references public.tam_regrade_runs(id) on delete restrict,
 seed_id uuid not null references public.tam_regrade_checkpoint_seeds(id),
 input_sha256 text not null check(input_sha256 ~ '^[a-f0-9]{64}$'),
 result jsonb not null, created_at timestamptz not null default now()
);
alter table public.tam_dispatch_gates enable row level security;
alter table public.tam_dispatch_gate_operations enable row level security;
revoke all on public.tam_dispatch_gates,public.tam_dispatch_gate_operations from public,anon,authenticated,service_role;
grant select on public.tam_dispatch_gates,public.tam_dispatch_gate_operations to service_role;

create function public.tam_dispatch_gate_status(p_run_slug text,p_seed_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare r tam_regrade_runs; g tam_dispatch_gates;
begin
 select * into r from tam_regrade_runs where slug=p_run_slug;
 if not found then raise exception 'TAM regrade run not found: %',p_run_slug; end if;
 if p_seed_id is not null and (r.completed_checkpoint_seed_id is distinct from p_seed_id or not exists(
  select 1 from tam_regrade_checkpoint_seeds where id=p_seed_id and run_id=r.id and status='complete'))
 then raise exception 'dispatch gate completed seed differs'; end if;
 select * into g from tam_dispatch_gates where run_id=r.id;
 if found and g.seed_id is distinct from r.completed_checkpoint_seed_id then raise exception 'dispatch gate stored seed differs'; end if;
 return jsonb_build_object('runId',r.id,'runSlug',r.slug,'seedId',r.completed_checkpoint_seed_id,
  'paused',coalesce(g.paused,false),'revision',coalesce(g.revision,0),'operationId',g.operation_id,'updatedAt',g.updated_at);
end $$;

create function public.tam_set_dispatch_gate(p_run_slug text,p_seed_id uuid,p_operation_id uuid,
 p_expected_revision bigint,p_expected_paused boolean,p_paused boolean,p_actor_key text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare r tam_regrade_runs; g tam_dispatch_gates; prior tam_dispatch_gate_operations;
 input_hash text; result jsonb;
begin
 if p_seed_id is null or p_operation_id is null or p_expected_revision is null or p_expected_revision<0
  or p_expected_paused is null or p_paused is null or p_actor_key is null or length(trim(p_actor_key)) not between 1 and 80
 then raise exception 'exact dispatch gate operation and expected state required'; end if;
 -- The run lock serializes both the absent/default gate and later transitions.
 select * into r from tam_regrade_runs where slug=p_run_slug for update;
 if not found or r.completed_checkpoint_seed_id is distinct from p_seed_id or not exists(
  select 1 from tam_regrade_checkpoint_seeds where id=p_seed_id and run_id=r.id and status='complete')
 then raise exception 'dispatch gate exact completed run/seed required'; end if;
 input_hash:=encode(sha256(convert_to(jsonb_build_array(p_run_slug,p_seed_id,p_operation_id,p_expected_revision,p_expected_paused,p_paused,p_actor_key)::text,'UTF8')),'hex');
 select * into prior from tam_dispatch_gate_operations where operation_id=p_operation_id;
 if found then
  if prior.input_sha256 is distinct from input_hash or prior.run_id is distinct from r.id or prior.seed_id is distinct from p_seed_id
  then raise exception 'dispatch gate operation identity differs'; end if;
  return jsonb_build_object('applied',false,'alreadyApplied',true,'operation',prior.result,'gate',tam_dispatch_gate_status(p_run_slug,p_seed_id));
 end if;
 select * into g from tam_dispatch_gates where run_id=r.id for update;
 if (g.run_id is not null and g.seed_id is distinct from p_seed_id)
  or coalesce(g.revision,0)<>p_expected_revision or coalesce(g.paused,false) is distinct from p_expected_paused
 then raise exception 'dispatch gate expected previous state differs'; end if;
 insert into tam_dispatch_gates(run_id,seed_id,paused,revision,operation_id,actor_key)
 values(r.id,p_seed_id,p_paused,p_expected_revision+1,p_operation_id,p_actor_key)
 on conflict(run_id) do update set paused=excluded.paused,revision=excluded.revision,operation_id=excluded.operation_id,
  actor_key=excluded.actor_key,updated_at=now();
 result:=jsonb_build_object('operationId',p_operation_id,'runId',r.id,'runSlug',r.slug,'seedId',p_seed_id,
  'paused',p_paused,'revision',p_expected_revision+1,'expectedRevision',p_expected_revision,'expectedPaused',p_expected_paused);
 insert into tam_dispatch_gate_operations(operation_id,run_id,seed_id,input_sha256,result)
 values(p_operation_id,r.id,p_seed_id,input_hash,result);
 insert into tam_regrade_events(run_id,actor_key,kind,summary,metadata) values(r.id,p_actor_key,'dispatch.admission_gate',
  case when p_paused then 'Paused new pending-record dispatch; admitted grading work remains available.'
   else 'Resumed pending-record dispatch for the exact canonical run.' end,result);
 return jsonb_build_object('applied',true,'alreadyApplied',false,'operation',result,'gate',tam_dispatch_gate_status(p_run_slug,p_seed_id));
end $$;
revoke all on function public.tam_dispatch_gate_status(text,uuid),public.tam_set_dispatch_gate(text,uuid,uuid,bigint,boolean,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.tam_dispatch_gate_status(text,uuid),public.tam_set_dispatch_gate(text,uuid,uuid,bigint,boolean,boolean,text) to service_role;
notify pgrst,'reload schema';
commit;
