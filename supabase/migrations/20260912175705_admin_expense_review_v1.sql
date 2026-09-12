-- Read APIs keep caller RLS. Only the narrowly scoped decision needs privileged
-- UPDATE: money_movements intentionally has no authenticated UPDATE policy.
create or replace function public.admin_expense_review_v1(p_movement_id bigint)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v public.money_movements%rowtype; v_rows jsonb; v_eligible boolean;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo administración puede revisar egresos.' using errcode='42501';
  end if;
  select * into v from public.money_movements where id=p_movement_id;
  if not found then raise exception 'Movimiento no disponible.' using errcode='22023'; end if;
  select jsonb_agg(to_jsonb(m) || jsonb_build_object(
    'account_name',a.name,'account_active',a.is_active,'account_currency',a.currency_code,
    'creator_name',p.full_name,'reviewer_name',reviewer.full_name) order by m.id),
    count(*) filter(where m.movement_type='expense_payment')=1
    and count(*) filter(where m.movement_type='fee_charge')<=1
    and bool_and(m.movement_type::text in ('expense_payment','fee_charge')
      and m.direction='outflow' and m.order_id is null and m.payment_report_id is null
      and m.money_account_id=v.money_account_id and m.currency_code=v.currency_code
      and m.movement_date=v.movement_date
      and m.created_by_user_id is not distinct from v.created_by_user_id
      and m.exchange_rate_ves_per_usd is not distinct from v.exchange_rate_ves_per_usd
      and m.status='pending' and m.approval_required
      and a.is_active and a.currency_code=m.currency_code)
    into v_rows,v_eligible
  from public.money_movements m join public.money_accounts a on a.id=m.money_account_id
  left join public.profiles p on p.id=m.created_by_user_id
  left join public.profiles reviewer on reviewer.id=m.reviewed_by_user_id
  where (v.movement_group_id is not null and m.movement_group_id=v.movement_group_id)
     or (v.movement_group_id is null and m.id=v.id);
  return jsonb_build_object('movementId',v.id,'snapshot',md5(v_rows::text),
    'eligible',coalesce(v_eligible,false),'rows',coalesce(v_rows,'[]'::jsonb));
end $$;
revoke all on function public.admin_expense_review_v1(bigint) from public,anon;
grant execute on function public.admin_expense_review_v1(bigint) to authenticated;

create or replace function app_private.decide_admin_expense_v1(
  p_movement_id bigint,p_snapshot text,p_decision text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path = ''
set lock_timeout='3s' set statement_timeout='10s' as $$
declare v_review jsonb; v_ids bigint[]; v_now timestamptz:=clock_timestamp(); v_result jsonb;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo administración puede autorizar egresos.' using errcode='42501';
  end if;
  if p_movement_id is null or p_movement_id<=0 or p_snapshot is null
    or p_snapshot !~ '^[a-f0-9]{32}$' or p_decision is null
    or p_decision not in ('approve','reject') then
    raise exception 'Revisión inválida.' using errcode='22023';
  end if;
  if p_decision='reject' and (nullif(btrim(p_reason),'') is null or length(p_reason)>800) then
    raise exception 'Indica un motivo de rechazo de hasta 800 caracteres.' using errcode='22023';
  end if;
  -- Existing writers do not share an advisory-lock protocol. This short lock
  -- prevents new group members while checking the exact reviewed snapshot.
  -- No network or user interaction occurs within this transaction.
  lock table public.money_movements in share row exclusive mode;
  perform a.id from public.money_accounts a where a.id in (
    select m.money_account_id from public.money_movements m
    join public.money_movements origin on origin.id=p_movement_id
    where m.id=origin.id or (origin.movement_group_id is not null and m.movement_group_id=origin.movement_group_id)
  ) order by a.id for share;
  v_review:=public.admin_expense_review_v1(p_movement_id);
  if v_review->>'snapshot' is distinct from p_snapshot then
    return jsonb_build_object('status','stale');
  end if;
  if not (v_review->>'eligible')::boolean then
    raise exception 'Este movimiento requiere revisión en su operación de origen o ya fue resuelto.' using errcode='22023';
  end if;
  select array_agg((r->>'id')::bigint order by (r->>'id')::bigint) into v_ids
    from jsonb_array_elements(v_review->'rows') r;
  update public.money_movements set
    status=case when p_decision='approve' then 'confirmed'::public.money_movement_status else 'rejected'::public.money_movement_status end,
    approval_required=false,
    reviewed_at=v_now,reviewed_by_user_id=auth.uid(),
    confirmed_at=case when p_decision='approve' then v_now else null end,
    confirmed_by_user_id=case when p_decision='approve' then auth.uid() else null end,
    rejected_at=case when p_decision='reject' then v_now else null end,
    rejected_by_user_id=case when p_decision='reject' then auth.uid() else null end,
    rejection_reason=case when p_decision='reject' then btrim(p_reason) else null end
  where id=any(v_ids);
  select jsonb_build_object('status','decided','decision',p_decision,
    'movementIds',to_jsonb(v_ids),'reviewedAt',v_now,'reviewedBy',auth.uid()) into v_result;
  return v_result;
end $$;
revoke all on function app_private.decide_admin_expense_v1(bigint,text,text,text) from public,anon;
grant execute on function app_private.decide_admin_expense_v1(bigint,text,text,text) to authenticated;

create or replace function public.decide_admin_expense_v1(
  p_movement_id bigint,p_snapshot text,p_decision text,p_reason text default null)
returns jsonb language sql security invoker set search_path = '' as $$
  select app_private.decide_admin_expense_v1(p_movement_id,p_snapshot,p_decision,p_reason);
$$;
revoke all on function public.decide_admin_expense_v1(bigint,text,text,text) from public,anon;
grant execute on function public.decide_admin_expense_v1(bigint,text,text,text) to authenticated;

create or replace function public.admin_authorizations_v1(p_kind text default 'all',p_page integer default 1)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if auth.uid() is null or not public.has_role('admin') then
    raise exception 'Solo administración puede consultar autorizaciones.' using errcode='42501';
  end if;
  if p_kind is null or p_kind not in ('all','expense','order','reapproval','payment')
    or p_page is null or p_page<1 or p_page>10000 then
    raise exception 'Filtro inválido.' using errcode='22023';
  end if;
  with pending as (
    select 'expense'::text kind,min(m.id) id,null::bigint order_id,
      min(m.created_at) created_at,min(m.description) title,
      string_agg(distinct a.name,' / ') entity,
      min(m.created_by_user_id::text) actor_id,
      case when count(distinct m.currency_code)=1 then min(m.currency_code::text) end currency,
      case when count(distinct m.currency_code)=1 then sum(m.amount) end amount,
      null::text focus_date
    from public.money_movements m join public.money_accounts a on a.id=m.money_account_id
    where m.status='pending' and m.approval_required
    group by coalesce(m.movement_group_id::text,'id:'||m.id::text)
    union all
    select case when o.status='created' then 'order' else 'reapproval' end,o.id,o.id,
      o.created_at,case when o.status='created' then 'Aprobar orden' else 'Ratificar modificación' end,
      c.full_name,o.created_by_user_id::text,'USD',o.total_usd,o.extra_fields->'schedule'->>'date'
    from public.orders o left join public.clients c on c.id=o.client_id
    where (o.status='created' and coalesce(o.extra_fields->'review'->>'returned_to_advisor','false')<>'true')
      or (o.status='queued' and o.queued_needs_reapproval)
    union all
    select 'payment',r.id,r.order_id,r.created_at,'Revisar pago reportado',c.full_name,
      r.created_by_user_id::text,r.reported_currency_code::text,r.reported_amount,o.extra_fields->'schedule'->>'date'
    from public.payment_reports r join public.orders o on o.id=r.order_id
    left join public.clients c on c.id=o.client_id where r.status='pending'
  ), filtered as (select * from pending where p_kind='all' or kind=p_kind),
  page_rows as (select f.*,p.full_name actor_name from filtered f left join public.profiles p on p.id::text=f.actor_id
    order by f.created_at,f.kind,f.id limit 30 offset (p_page-1)*30)
  select jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at,r.kind,r.id) from page_rows r),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',p_page,
    'counts',(select coalesce(jsonb_object_agg(kind,n),'{}'::jsonb) from (select kind,count(*) n from pending group by kind) c)) into v_result;
  return v_result;
end $$;
revoke all on function public.admin_authorizations_v1(text,integer) from public,anon;
grant execute on function public.admin_authorizations_v1(text,integer) to authenticated;
