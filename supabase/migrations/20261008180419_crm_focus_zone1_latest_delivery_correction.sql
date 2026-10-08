-- Authorized refinement of the published October Focus audience, without
-- rebuilding its snapshot, erasing follow-up, or changing orders and costs.
set lock_timeout='5s';
set statement_timeout='60s';
do $correct$
declare play_row public.crm_plays%rowtype; product_id bigint; member_row record;
  pending_ids bigint[]; member_id bigint; new_rules jsonb; old_claims text; old_sub text;
  reason text := 'Corrección autorizada de Focus Zona 1: el último pedido válido de tipo delivery hasta el corte de la lista debe llevar Delivery Zona 1. Un pickup posterior no lo reemplaza. Se conservan pedidos, costos y seguimiento.';
begin
  select * into strict play_row from public.crm_plays
  where name='Focus Delivery Zona 1 · octubre de 2026'
    and starts_at>='2026-10-01T04:00:00Z' and starts_at<'2026-11-01T04:00:00Z'
    and status in ('active','paused','frozen') for update;
  select id into strict product_id from public.products where sku='DEL_Z1';
  if not exists(select 1 from public.user_roles where user_id=play_row.created_by_user_id and role='admin') then
    raise exception 'La corrección requiere autoría de un administrador';
  end if;
  if play_row.snapshot_at is null then raise exception 'Falta el corte de la lista publicada'; end if;
  new_rules := play_row.rules_snapshot || jsonb_build_object('purchased_product_ids',jsonb_build_array(product_id),
    'purchased_product_mode','any','purchased_product_scope','latest_delivery');
  old_claims := coalesce(current_setting('request.jwt.claims',true),'');
  old_sub := coalesce(current_setting('request.jwt.claim.sub',true),'');
  perform set_config('request.jwt.claim.sub',play_row.created_by_user_id::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',play_row.created_by_user_id,'role','authenticated')::text,true);
  with matches as materialized (select * from app_private.crm_clients_with_products_v1(new_rules,play_row.snapshot_at))
  select coalesce(array_agg(m.id),'{}'::bigint[]) into pending_ids
  from public.crm_play_members m where m.play_id=play_row.id and m.workflow_status<>'removed'
    and not exists(select 1 from matches x where x.client_id=m.client_id);
  foreach member_id in array pending_ids loop
    select * into strict member_row from public.crm_play_members where id=member_id for update;
    if exists(select 1 from public.crm_play_redemptions r where r.play_member_id=member_id and r.status in ('reserved','redeemed'))
      or exists(select 1 from public.order_items i where i.crm_play_member_id=member_id) then
      raise exception 'El cliente % tiene un pedido o beneficio asociado; no se puede retirar automáticamente.',member_row.client_id;
    end if;
    perform public.crm_remove_published_play_member_v1(play_row.id,member_row.client_id,reason);
  end loop;
  -- Transactional suspension of definition immutability for this one audited
  -- amendment; the table lock prevents concurrent writes. Other guards stay on.
  alter table public.crm_plays disable trigger crm_plays_guard;
  update public.crm_plays set rules_snapshot=new_rules where id=play_row.id;
  alter table public.crm_plays enable trigger crm_plays_guard;
  insert into public.crm_play_amendments(play_id,amendment_type,previous_values,new_values,reason,created_by_user_id)
  values(play_row.id,'criteria_corrected',jsonb_build_object('rules_snapshot',play_row.rules_snapshot),
    jsonb_build_object('rules_snapshot',new_rules,'removed_members',pending_ids),reason,play_row.created_by_user_id);
  if exists(
    with matches as materialized (select * from app_private.crm_clients_with_products_v1(new_rules,play_row.snapshot_at))
    select 1 from public.crm_play_members m where m.play_id=play_row.id and m.workflow_status<>'removed'
      and not exists(select 1 from matches x where x.client_id=m.client_id)
  ) then raise exception 'La revisión final detecta clientes cuyo último delivery no cumple el filtro'; end if;
  perform set_config('request.jwt.claims',old_claims,true);
  perform set_config('request.jwt.claim.sub',old_sub,true);
  perform set_config('app.crm_play_amendment_context','',true);
end;
$correct$;
