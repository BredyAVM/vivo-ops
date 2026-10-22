-- Version aligned with the applied linked-project migration.
begin;
set local lock_timeout = '5s';

-- Recipients commit with the canonical creation event. No new event/ledger.
create or replace function app_private.advisor_created_recipients_v1()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare v_advisor uuid;
begin
  select o.attributed_advisor_id into v_advisor from public.orders o
    where o.id=new.order_id and o.source::text='advisor'
      and o.created_by_user_id=new.actor_user_id
      and o.attributed_advisor_id=new.actor_user_id;
  if not found then return new; end if;
  insert into public.order_timeline_event_recipients(event_id,target_role,target_user_id,requires_action)
    select new.id,r.role,r.user_id,r.action from
      (values ('master'::text,null::uuid,true),('admin',null::uuid,true),(null,v_advisor,false)) r(role,user_id,action)
    where not exists (select 1 from public.order_timeline_event_recipients existing
      where existing.event_id=new.id and existing.target_role is not distinct from r.role
        and existing.target_user_id is not distinct from r.user_id);
  return new;
end;
$$;
revoke all on function app_private.advisor_created_recipients_v1() from public,anon,authenticated;
create trigger advisor_created_recipients_v1 after insert on public.order_timeline_events
  for each row when (new.event_type='order_created')
  execute function app_private.advisor_created_recipients_v1();

-- Only trusted server code may claim transport, after checking the real session.
-- A permanent claim precedes external I/O: even an ambiguous send is not replayed.
create or replace function public.claim_advisor_created_push_v1(
  p_order_id bigint,p_advisor_id uuid,p_claim_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_order public.orders%rowtype;
  v_event public.order_timeline_events%rowtype;
begin
  if p_claim_id is null or p_advisor_id is null then
    raise exception 'Invalid notification claim.' using errcode='22023';
  end if;
  select * into v_order from public.orders where id=p_order_id for update;
  if not found or v_order.source::text<>'advisor'
    or v_order.created_by_user_id is distinct from p_advisor_id
    or v_order.attributed_advisor_id is distinct from p_advisor_id then
    raise exception 'Not the creator of this advisor order.' using errcode='42501';
  end if;
  -- Do not turn a replay of an old/approved order into a new-order alert.
  if v_order.status::text<>'created' or v_order.created_at < statement_timestamp()-interval '15 minutes'
    or not exists(select 1 from public.order_items where order_id=p_order_id) then
    return jsonb_build_object('claimed',false,'reason','not_pending_recent_creation');
  end if;
  select * into v_event from public.order_timeline_events
    where order_id=p_order_id and event_type='order_created' order by id limit 1 for update;
  if not found then
    -- Compatibility entry point; the atomic writer normally already made it.
    insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,created_at)
    values(p_order_id,v_order.order_number,'order_created','approval','Orden creada',
      'La orden fue creada y quedó pendiente de aprobación.','warning',p_advisor_id,v_order.created_at)
    returning * into v_event;
  end if;
  if v_event.actor_user_id is distinct from p_advisor_id then
    raise exception 'Invalid creation event actor.' using errcode='42501';
  end if;
  insert into public.order_timeline_event_recipients(event_id,target_role,target_user_id,requires_action)
    select v_event.id,r.role,r.user_id,r.action from
      (values ('master'::text,null::uuid,true),('admin',null::uuid,true),(null,p_advisor_id,false)) r(role,user_id,action)
    where not exists (select 1 from public.order_timeline_event_recipients existing
      where existing.event_id=v_event.id and existing.target_role is not distinct from r.role
        and existing.target_user_id is not distinct from r.user_id);
  if v_event.payload ? 'master_created_push' then
    return jsonb_build_object('claimed',false,'reason','already_claimed','eventId',v_event.id);
  end if;
  update public.order_timeline_events set payload=payload || jsonb_build_object('master_created_push',
    jsonb_build_object('claim_id',p_claim_id,'claimed_at',clock_timestamp(),'status','claimed'))
    where id=v_event.id;
  return jsonb_build_object('claimed',true,'eventId',v_event.id);
end;
$$;
revoke all on function public.claim_advisor_created_push_v1(bigint,uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_advisor_created_push_v1(bigint,uuid,uuid) to service_role;

create or replace function public.finish_advisor_created_push_v1(
  p_event_id bigint,p_claim_id uuid,p_status text,p_delivered integer,p_failures integer
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare v_rows integer;
begin
  if p_status is null or p_status not in ('sent','partial','failed','skipped','uncertain')
    or p_delivered is null or p_failures is null or p_delivered<0 or p_failures<0 then
    raise exception 'Invalid notification outcome.' using errcode='22023';
  end if;
  update public.order_timeline_events set payload=jsonb_set(payload,'{master_created_push}',
    (payload->'master_created_push') || jsonb_build_object('status',p_status,
      'finished_at',clock_timestamp(),'delivered',p_delivered,'failures',p_failures))
    where id=p_event_id and event_type='order_created'
      and payload #>> '{master_created_push,claim_id}'=p_claim_id::text
      and payload #>> '{master_created_push,status}'='claimed';
  get diagnostics v_rows=row_count;
  return v_rows=1;
end;
$$;
revoke all on function public.finish_advisor_created_push_v1(bigint,uuid,text,integer,integer) from public,anon,authenticated;
grant execute on function public.finish_advisor_created_push_v1(bigint,uuid,text,integer,integer) to service_role;
commit;
