create or replace function public.admin_order_review_v1(p_order_id bigint)
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare v_order jsonb; v_items jsonb; v_finance jsonb; v_changes jsonb; v_action text;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo administración puede revisar estas órdenes.' using errcode='42501';
  end if;
  select to_jsonb(o)||jsonb_build_object('client_name',c.full_name,'advisor_name',p.full_name)
    into v_order from public.orders o left join public.clients c on c.id=o.client_id
    left join public.profiles p on p.id=o.attributed_advisor_id where o.id=p_order_id;
  if v_order is null then raise exception 'Orden no disponible.' using errcode='22023'; end if;
  select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) into v_items
    from public.order_items i where i.order_id=p_order_id;
  select to_jsonb(f) into v_finance from public.get_order_financial_state(p_order_id) f;
  select coalesce(jsonb_agg(to_jsonb(e) order by e.created_at desc,e.id desc),'[]'::jsonb) into v_changes
    from (select t.id,t.title,t.message,t.payload,t.created_at,p.full_name actor_name
      from public.order_timeline_events t left join public.profiles p on p.id=t.actor_user_id
      where t.order_id=p_order_id and t.event_type='order_modified'
      order by t.created_at desc,t.id desc limit 10) e;
  v_action:=case
    when v_order->>'status'='created' and coalesce(v_order->'extra_fields'->'review'->>'returned_to_advisor','false')<>'true' then 'approve'
    when v_order->>'status'='queued' and coalesce((v_order->>'queued_needs_reapproval')::boolean,false) then 'reapprove'
    else null end;
  return jsonb_build_object('order',v_order,'items',v_items,'financial',v_finance,'changes',v_changes,
    'action',v_action,'snapshot',md5(jsonb_build_object('order',v_order,'items',v_items)::text));
end $$;
revoke all on function public.admin_order_review_v1(bigint) from public,anon;
grant execute on function public.admin_order_review_v1(bigint) to authenticated;

create or replace function app_private.approve_admin_order_review_v1(p_order_id bigint,p_snapshot text,p_action text,p_notes text default null)
returns jsonb language plpgsql security definer set search_path='' set lock_timeout='3s' set statement_timeout='15s' as $$
declare v_review jsonb; v_order public.orders%rowtype; v_event bigint; v_type text; v_title text; v_message text;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo administración puede aprobar esta revisión.' using errcode='42501';
  end if;
  if p_order_id is null or p_order_id<=0 or p_snapshot is null or p_snapshot !~ '^[a-f0-9]{32}$'
    or p_action is null or p_action not in ('approve','reapprove') or length(coalesce(p_notes,''))>800 then
    raise exception 'Revisión inválida.' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('order-edit:'||p_order_id::text,0));
  select * into v_order from public.orders where id=p_order_id for update;
  if not found then raise exception 'Orden no disponible.' using errcode='22023'; end if;
  perform id from public.order_items where order_id=p_order_id order by id for update;
  v_review:=public.admin_order_review_v1(p_order_id);
  if v_review->>'snapshot' is distinct from p_snapshot or v_review->>'action' is distinct from p_action then
    return jsonb_build_object('status','stale');
  end if;
  -- Preserve protected inventory allocations, status rules and canonical audit.
  if p_action='approve' then perform public.approve_order(p_order_id);
  else perform public.reapprove_queued_order(p_order_id,nullif(btrim(p_notes),'')); end if;
  v_type:=case when p_action='approve' then 'order_approved' else 'order_reapproved' end;
  v_title:=case when p_action='approve' then 'Orden aprobada' else 'Orden re-aprobada' end;
  v_message:=coalesce(nullif(btrim(p_notes),''),'Revisión confirmada desde Administración.');
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(p_order_id,v_order.order_number,v_type,'approval',v_title,v_message,'info',auth.uid(),
      jsonb_build_object('reviewed_snapshot',p_snapshot,'source','admin_review')) returning id into v_event;
  insert into public.order_timeline_event_recipients(event_id,target_role,requires_action) values(v_event,'master',false);
  if v_order.attributed_advisor_id is not null then
    insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action) values(v_event,v_order.attributed_advisor_id,false);
  end if;
  return jsonb_build_object('status','approved','orderId',p_order_id,'eventId',v_event,'action',p_action,
    'advisorId',v_order.attributed_advisor_id,'orderNumber',v_order.order_number,'clientName',v_review->'order'->>'client_name',
    'title',v_title,'message',v_message,'eventType',v_type);
end $$;
revoke all on function app_private.approve_admin_order_review_v1(bigint,text,text,text) from public,anon;
grant execute on function app_private.approve_admin_order_review_v1(bigint,text,text,text) to authenticated;
create or replace function public.approve_admin_order_review_v1(p_order_id bigint,p_snapshot text,p_action text,p_notes text default null)
returns jsonb language sql security invoker set search_path='' as $$
  select app_private.approve_admin_order_review_v1(p_order_id,p_snapshot,p_action,p_notes);
$$;
revoke all on function public.approve_admin_order_review_v1(bigint,text,text,text) from public,anon;
grant execute on function public.approve_admin_order_review_v1(bigint,text,text,text) to authenticated;
