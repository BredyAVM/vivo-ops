-- Daily benefits use the scheduled fulfillment day (Caracas), not the time the
-- advisor opens WhatsApp or creates the order. On delivery, the actual day wins.
set lock_timeout = '5s';
set statement_timeout = '30s';

alter table public.crm_plays
  add column benefit_recurrence_mode text not null default 'once'
    check (benefit_recurrence_mode in ('once','daily')),
  add column benefit_fulfillment text not null default 'any'
    check (benefit_fulfillment in ('any','pickup','delivery_zone_1')),
  add constraint crm_daily_single_benefit check
    (benefit_recurrence_mode <> 'daily' or benefit_selection_mode = 'single');

alter table public.crm_play_redemptions
  add column recurrence_mode_snapshot text not null default 'once'
    check (recurrence_mode_snapshot in ('once','daily')),
  add column benefit_day date,
  add constraint crm_daily_day_required check
    (recurrence_mode_snapshot <> 'daily' or benefit_day is not null);

drop index public.crm_play_redemptions_active_member_benefit_unique;
create unique index crm_play_redemptions_active_member_benefit_unique
  on public.crm_play_redemptions(play_member_id,play_benefit_id)
  where status in ('reserved','redeemed') and play_benefit_id is not null
    and recurrence_mode_snapshot = 'once';
create unique index crm_play_redemptions_daily_member_unique
  on public.crm_play_redemptions(play_member_id,benefit_day)
  where status in ('reserved','redeemed') and recurrence_mode_snapshot = 'daily';

create function app_private.crm_is_delivery_product_v1(p_name text,p_sku text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_name,'') ~* 'delivery'
    or coalesce(p_sku,'') ~* '(^|_)DEL(IV)?(_|$)';
$$;

create function app_private.crm_order_benefit_day_v1(p_order_id bigint)
returns date language sql stable set search_path = '' as $$
  select case when o.status::text='delivered' then (now() at time zone 'America/Caracas')::date
    else coalesce(nullif(o.extra_fields #>> '{schedule,date}','')::date,
      (now() at time zone 'America/Caracas')::date) end
  from public.orders o where o.id=p_order_id;
$$;

create function app_private.crm_paid_products_subtotal_v1(p_order_id bigint)
returns numeric language sql stable set search_path = '' as $$
  select round(coalesce(sum(i.line_total_usd) filter (
    where i.crm_play_member_id is null and i.line_total_usd > 0
      and not app_private.crm_is_delivery_product_v1(p.name,p.sku)),0)
    * (1 - greatest(0,least(100,coalesce(nullif(o.extra_fields #>> '{pricing,discount_pct}','')::numeric,0)))/100),2)
  from public.orders o left join public.order_items i on i.order_id=o.id
  left join public.products p on p.id=i.product_id where o.id=p_order_id group by o.id;
$$;

create function app_private.crm_daily_redemption_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
declare mode text; expected_day date;
begin
  if tg_op='UPDATE' then
    if new.recurrence_mode_snapshot is distinct from old.recurrence_mode_snapshot then
      raise exception 'La modalidad del beneficio reservado es inmutable.' using errcode='55000';
    end if;
    if new.benefit_day is distinct from old.benefit_day then
      expected_day:=app_private.crm_order_benefit_day_v1(new.order_id);
      if old.status<>'reserved' or new.status<>'reserved'
        or old.recurrence_mode_snapshot<>'daily' or new.benefit_day is distinct from expected_day
        or (to_jsonb(new)-'benefit_day') is distinct from (to_jsonb(old)-'benefit_day') then
        raise exception 'Solo una reserva diaria puede seguir la nueva fecha del pedido.' using errcode='55000';
      end if;
    end if;
    return new;
  end if;
  select p.benefit_recurrence_mode into mode from public.crm_play_members m
    join public.crm_plays p on p.id=m.play_id where m.id=new.play_member_id;
  new.recurrence_mode_snapshot:=coalesce(mode,'once');
  new.benefit_day:=case when mode='daily' then app_private.crm_order_benefit_day_v1(new.order_id) else null end;
  return new;
end;
$$;
create trigger crm_play_redemptions_00_daily_guard before insert or update
  on public.crm_play_redemptions for each row execute function app_private.crm_daily_redemption_guard_v1();

create function app_private.crm_sync_daily_order_day_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status::text='cancelled' then return new; end if;
  update public.crm_play_redemptions r set benefit_day=app_private.crm_order_benefit_day_v1(new.id)
  where r.order_id=new.id and r.status='reserved' and r.recurrence_mode_snapshot='daily'
    and r.benefit_day is distinct from app_private.crm_order_benefit_day_v1(new.id);
  return new;
exception when unique_violation then
  raise exception 'El cliente ya tiene un beneficio reservado o entregado para ese día. Elige otro día o retira el beneficio.' using errcode='23514';
end;
$$;
create trigger orders_00_sync_crm_daily_day after update of extra_fields,status on public.orders
  for each row execute function app_private.crm_sync_daily_order_day_v1();

create function app_private.crm_assert_order_benefit_channel_v1(p_order_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare b record;
begin
  for b in select distinct p.benefit_fulfillment,o.fulfillment::text channel
    from public.orders o join public.order_items i on i.order_id=o.id
    join public.crm_play_members m on m.id=i.crm_play_member_id
    join public.crm_plays p on p.id=m.play_id
    where o.id=p_order_id and o.status::text<>'cancelled' loop
    if b.benefit_fulfillment='pickup' and b.channel<>'pickup' then
      raise exception 'Esta jugada requiere retirar el pedido en el local.' using errcode='23514';
    elsif b.benefit_fulfillment='delivery_zone_1' and (
      b.channel<>'delivery' or not exists(select 1 from public.order_items i
        join public.products p on p.id=i.product_id
        where i.order_id=p_order_id and i.crm_play_member_id is not null
          and p.sku='DEL_Z1' and i.qty=1)
      or (select count(*) from public.order_items i join public.products p on p.id=i.product_id
          where i.order_id=p_order_id and app_private.crm_is_delivery_product_v1(p.name,p.sku)) <> 1
    ) then
      raise exception 'Focus Zona 1 requiere delivery zona 1 y un solo envío en el pedido.' using errcode='23514';
    end if;
  end loop;
end;
$$;

create function app_private.crm_benefit_channel_deferred_guard_v1()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name='orders' then
    perform app_private.crm_assert_order_benefit_channel_v1(new.id);
  else
    if tg_op<>'INSERT' then perform app_private.crm_assert_order_benefit_channel_v1(old.order_id); end if;
    if tg_op<>'DELETE' then perform app_private.crm_assert_order_benefit_channel_v1(new.order_id); end if;
  end if;
  return null;
end;
$$;
create constraint trigger crm_benefit_channel_items after insert or update or delete on public.order_items
  deferrable initially deferred for each row execute function app_private.crm_benefit_channel_deferred_guard_v1();
create constraint trigger crm_benefit_channel_orders after update on public.orders
  deferrable initially deferred for each row execute function app_private.crm_benefit_channel_deferred_guard_v1();

-- Preserve the installed lifecycle/auth/exception guards. Fail atomically if an
-- anchor changed, rather than replacing unrelated recent financial amendments.
do $patch$
declare s text; changed text;
begin
  s:=pg_get_functiondef('app_private.crm_order_minimum_state_v1(bigint)'::regprocedure);
  changed:=replace(s, 'round(coalesce(sum(i.line_total_usd) filter (where i.crm_play_member_id is null), 0)' || E'\n' ||
    '        * (1 - greatest(0, least(100, coalesce(' || E'\n' ||
    '          nullif(o.extra_fields #>> ''{pricing,discount_pct}'', '''')::numeric, 0))) / 100), 2)',
    'app_private.crm_paid_products_subtotal_v1(o.id)');
  if changed=s then raise exception 'Minimum subtotal anchor changed'; end if; execute changed;

  foreach s in array array[
    'app_private.crm_order_item_guard_v1()', 'app_private.crm_play_redemption_guard_v1()',
    'public.crm_set_play_benefits_v2(bigint,bigint[])'
  ] loop
    changed:=pg_get_functiondef(s::regprocedure);
    changed:=replace(changed,'member_row.benefit_status not in (''available'', ''reserved'')',
      '(member_row.benefit_status not in (''available'', ''reserved'') and not exists (' ||
      'select 1 from public.crm_plays rp where rp.id=member_row.play_id and rp.benefit_recurrence_mode=''daily''))');
    if changed=pg_get_functiondef(s::regprocedure) then raise exception 'Availability anchor changed: %',s; end if;
    if s='app_private.crm_play_redemption_guard_v1()' then
      changed:=replace(changed, '  if tg_op = ''UPDATE'' then',
        '  if tg_op = ''UPDATE'' and old.status=''reserved'' and new.status=''reserved'' and old.recurrence_mode_snapshot=''daily'' and new.benefit_day is distinct from old.benefit_day and (to_jsonb(new)-''benefit_day'') is not distinct from (to_jsonb(old)-''benefit_day'') then return new; end if;' || E'\n' || '  if tg_op = ''UPDATE'' then');
    end if;
    execute changed;
  end loop;

  s:=pg_get_functiondef('app_private.crm_reserve_order_item_benefit_v1()'::regprocedure);
  changed:=replace(s, 'and active_redemption.order_id <> new.order_id',
    'and active_redemption.order_id <> new.order_id and (active_redemption.recurrence_mode_snapshot=''once'' or active_redemption.benefit_day=app_private.crm_order_benefit_day_v1(new.order_id))');
  changed:=replace(changed,'benefit_redeemed_at = null,',
    'benefit_redeemed_at = case when exists (select 1 from public.crm_plays rp where rp.id=member.play_id and rp.benefit_recurrence_mode=''daily'') then member.benefit_redeemed_at else null end,');
  if changed=s then raise exception 'Reservation anchor changed'; end if; execute changed;

  s:=pg_get_functiondef('app_private.crm_order_validity_state_v1(bigint)'::regprocedure);
  changed:=replace(s, 'p.name, p.status play_status, p.starts_at, p.ends_at,',
    'p.name, p.status play_status, p.starts_at, p.ends_at, p.benefit_recurrence_mode,');
  changed:=replace(changed, 'p.name, p.status, p.starts_at, p.ends_at',
    'p.name, p.status, p.starts_at, p.ends_at, p.benefit_recurrence_mode');
  changed:=replace(changed,'b.benefit_status in (''available'',''reserved'',''expired'')',
    '(b.benefit_status in (''available'',''reserved'',''expired'') or b.benefit_recurrence_mode=''daily'')');
  changed:=replace(changed,'b.benefit_status in (''available'',''reserved'')',
    '(b.benefit_status in (''available'',''reserved'') or b.benefit_recurrence_mode=''daily'')');
  changed:=replace(changed, 'and (r.order_id <> b.id or r.status = ''redeemed'')',
    'and (r.order_id <> b.id or r.status = ''redeemed'') and (b.benefit_recurrence_mode=''once'' or r.benefit_day=app_private.crm_order_benefit_day_v1(b.id))');
  if changed=s then raise exception 'Validity anchor changed'; end if; execute changed;

  s:=pg_get_functiondef('app_private.crm_catalog_gift_candidates_v1(bigint,uuid,bigint)'::regprocedure);
  changed:=replace(s,'p.name,m.benefit_status,o.target_id',
    'p.name,case when p.benefit_recurrence_mode=''daily'' then ''available'' else m.benefit_status end,o.target_id');
  if changed=s then raise exception 'Catalog availability anchor changed'; end if; execute changed;

  s:=pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure);
  changed:=replace(s,'new.benefit_selection_mode is distinct from old.benefit_selection_mode',
    'new.benefit_recurrence_mode is distinct from old.benefit_recurrence_mode or new.benefit_fulfillment is distinct from old.benefit_fulfillment or new.benefit_selection_mode is distinct from old.benefit_selection_mode');
  if changed=s then raise exception 'Frozen terms anchor changed'; end if; execute changed;

  s:=pg_get_functiondef('public.crm_clone_play_v3(bigint,text,integer)'::regprocedure);
  changed:=replace(s,'  if p_shift_months > 0 then',
    '  update public.crm_plays set benefit_recurrence_mode=source_play.benefit_recurrence_mode, benefit_fulfillment=source_play.benefit_fulfillment where id=cloned_play_id;' || E'\n' || '  if p_shift_months > 0 then');
  if changed=s then raise exception 'Clone terms anchor changed'; end if; execute changed;
end;
$patch$;

revoke all on function app_private.crm_is_delivery_product_v1(text,text),
  app_private.crm_order_benefit_day_v1(bigint), app_private.crm_paid_products_subtotal_v1(bigint),
  app_private.crm_daily_redemption_guard_v1(), app_private.crm_sync_daily_order_day_v1(),
  app_private.crm_assert_order_benefit_channel_v1(bigint), app_private.crm_benefit_channel_deferred_guard_v1()
  from public,anon,authenticated,service_role;

-- Only reviewed, still-unpublished October Focus definitions receive daily mode.
-- Price splits, audiences and activation remain under the administrator's control.
update public.crm_plays set benefit_recurrence_mode='daily',
  benefit_fulfillment=case when rules_snapshot #>> '{october_2026_audit,segment}'='focus_pickup'
    then 'pickup' else 'delivery_zone_1' end,
  description=replace(description,'COSTOS Y RECURRENCIA PENDIENTES.','COSTOS PENDIENTES.'),
  advisor_guidance=replace(replace(replace(replace(replace(advisor_guidance,
    'por CADA compra pickup pagada elegible, sin límite mensual aprobado.',
    'una vez por cliente y por día de entrega con compra pickup elegible, repetible en distintos días.'),
    'por CADA pedido pagado elegible, sin límite mensual aprobado.',
    'una vez por cliente y por día de entrega con compra elegible, repetible en distintos días.'),
    'El módulo actual admite un canje por cliente: adaptar recurrencia antes de habilitar.',
    'Recurrencia diaria implementada; una reserva ocupa el día de entrega y cancelar o quitar el beneficio lo libera.'),
    'PENDIENTE ANTES DE PUBLICAR: el mínimo solicitado debe excluir obsequio y delivery; actualmente el sistema puede contar delivery dentro del mínimo. Validar/corregir esa diferencia operativa.',
    'Compra mínima en productos pagados implementada: excluye obsequios y delivery.'),
    'PENDIENTE ANTES DE HABILITAR: implementar recurrencia diaria y su control de reservas/entregas; el módulo actual permite un único canje por beneficio y cliente.',
    'Recurrencia diaria y control de reservas/entregas implementados. PENDIENTE ANTES DE HABILITAR: definir reparto de costos y configurar el beneficio.'),
  rules_snapshot=jsonb_set(jsonb_set(jsonb_set(rules_snapshot,
    '{october_2026_audit,recurrence_pending}','false'::jsonb),
    '{october_2026_audit,minimum_delivery_exclusion_pending}','false'::jsonb),
    '{october_2026_audit,daily_recurrence_definition,implementation_status}','"implemented"'::jsonb)
where status='draft' and rules_snapshot->>'import_review_batch'='october_2026_docx_draft_review_20261002'
  and rules_snapshot #>> '{october_2026_audit,segment}' in ('focus_pickup','focus_zone1');
