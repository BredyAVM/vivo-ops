-- Targeted correction of already-approved zero prices; not a historical backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $repair$
declare o public.orders%rowtype;actor uuid;before_items jsonb;protected_before jsonb;protected_after jsonb;pricing jsonb;
begin
  select * into strict o from public.orders where id=3637 for update;
  if o.last_modified_at is distinct from '2026-11-05T11:47:39.517+00:00'::timestamptz
    or o.status::text<>'ready' or o.fulfillment::text<>'pickup' or o.source::text<>'walk_in'
    or o.extra_fields#>>'{counter,quick_sale}' is distinct from 'true' or o.total_usd<>19.5 then
    raise exception 'La orden 36-37 cambió. Auditar de nuevo antes de corregir.';
  end if;
  perform 1 from public.order_items where order_id=o.id order by id for update;
  if (select count(*)from public.order_items where order_id=o.id)<>3 or exists(
    select 1 from public.order_items i where i.order_id=o.id and (i.id not in(16212,16213,16214)
      or i.qty<>1 or i.product_id not in(52,24,40) or i.admin_price_override_usd is distinct from 0
      or i.pricing_origin_currency<>'USD' or i.override_unit_price_usd is not null
      or i.crm_play_member_id is not null or i.reward_grant_id is not null
      or i.admin_price_override_by_user_id is distinct from 'ab6adac6-8785-43ee-b832-ffda538121f5'::uuid))then
    raise exception 'Las líneas o las aprobaciones de la orden 36-37 cambiaron.';
  end if;
  actor:='ab6adac6-8785-43ee-b832-ffda538121f5'::uuid;
  if not exists(select 1 from public.profiles p join public.user_roles u on u.user_id=p.id
    where p.id=actor and p.is_active and u.role::text='admin')then raise exception 'El administrador aprobador no está activo.';end if;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if public.is_admin() is not true then raise exception 'La corrección requiere autorización administrativa.';end if;
  if exists(select 1 from public.payment_reports where order_id=o.id)
    or exists(select 1 from public.money_movements where order_id=o.id)
    or exists(select 1 from public.client_fund_movements where order_id=o.id)
    or coalesce((o.extra_fields#>>'{payment,client_fund_used_usd}')::numeric,0)<>0 then
    raise exception 'La orden tiene registros financieros nuevos. Auditar de nuevo.';
  end if;
  select jsonb_agg(to_jsonb(i)order by i.id)into before_items from public.order_items i where i.order_id=o.id;
  select jsonb_build_object('stock',(select coalesce(jsonb_agg(to_jsonb(m)order by m.id),'[]')from public.inventory_movements m where m.order_id=o.id),
    'payments',(select count(*)from public.payment_reports where order_id=o.id),
    'money',(select count(*)from public.money_movements where order_id=o.id),
    'funds',(select count(*)from public.client_fund_movements where order_id=o.id))into protected_before;
  update public.order_items set pricing_origin_amount=0,unit_price_usd_snapshot=0,line_total_usd=0,
    unit_price_bs_snapshot=0,line_total_bs_snapshot=0 where order_id=o.id;
  pricing:=coalesce(o.extra_fields->'pricing','{}')||jsonb_build_object('subtotal_usd',0,'subtotal_bs',0,
    'discount_amount_usd',0,'discount_amount_bs',0,'subtotal_after_discount_usd',0,'subtotal_after_discount_bs',0,
    'invoice_tax_amount_usd',0,'invoice_tax_amount_bs',0,'total_usd',0,'total_bs',0);
  update public.orders set total_usd=0,total_bs_snapshot=0,extra_fields=jsonb_set(extra_fields,'{pricing}',pricing),
    last_modified_at=clock_timestamp(),last_modified_by=actor where id=o.id;
  if exists(select 1 from public.orders n where n.id=o.id and (n.status is distinct from o.status
    or n.source is distinct from o.source or n.fulfillment is distinct from o.fulfillment
    or n.client_id is distinct from o.client_id or n.attributed_advisor_id is distinct from o.attributed_advisor_id
    or (n.extra_fields-'pricing') is distinct from (o.extra_fields-'pricing')
    or n.extra_fields#>>'{pricing,fx_rate}' is distinct from o.extra_fields#>>'{pricing,fx_rate}'))then
    raise exception 'Cambió una condición operativa o la tasa de la orden.';
  end if;
  if exists(select 1 from public.order_items where order_id=o.id and (pricing_origin_amount<>0 or unit_price_usd_snapshot<>0
    or line_total_usd<>0 or unit_price_bs_snapshot<>0 or line_total_bs_snapshot<>0 or admin_price_override_usd<>0))then
    raise exception 'El precio cero no se conservó. La operación se revierte.';
  end if;
  select jsonb_build_object('stock',(select coalesce(jsonb_agg(to_jsonb(m)order by m.id),'[]')from public.inventory_movements m where m.order_id=o.id),
    'payments',(select count(*)from public.payment_reports where order_id=o.id),
    'money',(select count(*)from public.money_movements where order_id=o.id),
    'funds',(select count(*)from public.client_fund_movements where order_id=o.id))into protected_after;
  if protected_before is distinct from protected_after then raise exception 'Cambió un movimiento protegido. La operación se revierte.';end if;
  if (select jsonb_agg(to_jsonb(i)-array['pricing_origin_amount','unit_price_usd_snapshot','line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot'] order by i.id)
    from public.order_items i where order_id=o.id) is distinct from
    (select jsonb_agg(i-array['pricing_origin_amount','unit_price_usd_snapshot','line_total_usd','unit_price_bs_snapshot','line_total_bs_snapshot']order by(i->>'id')::bigint)
    from jsonb_array_elements(before_items)i)then raise exception 'Cambió una cantidad, detalle o evidencia de aprobación.';end if;
  insert into public.order_admin_adjustments(order_id,adjustment_type,reason,payload,created_by_user_id)
    values(o.id,'other','Corregir precios cero ya aprobados: Counter había restablecido el catálogo.',
      jsonb_build_object('kind','counter_price_override_repair_v1','before_total_usd',o.total_usd,'after_total_usd',0,
        'before_items',before_items,'payments_modified',false,'inventory_modified',false),actor);
end;
$repair$;
commit;
