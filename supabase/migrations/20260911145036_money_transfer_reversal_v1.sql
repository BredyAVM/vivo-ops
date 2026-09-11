-- Version aligned with the applied Supabase history.
begin;
set local lock_timeout='5s';
create function app_private.void_money_transfer_v1(p_movement_id bigint,p_group_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=''
as $fn$
declare v_uid uuid:=auth.uid(); v_op public.money_transfer_operations%rowtype; v_ids bigint[]; v_now timestamptz:=statement_timestamp();
begin
  if v_uid is null or not exists(select 1 from public.user_roles where user_id=v_uid and role='admin') then
    raise exception 'Solo admin puede anular traspasos.' using errcode='42501';
  end if;
  p_reason:=btrim(regexp_replace(coalesce(p_reason,''),'\s+',' ','g'));
  if length(p_reason) not between 6 and 500 then raise exception 'Indica un motivo claro para anular.' using errcode='22023'; end if;
  select * into v_op from public.money_transfer_operations
    where p_movement_id in (source_movement_id,target_movement_id,fee_movement_id)
      or (coalesce(p_movement_id,0)<=0 and request_id=p_group_id) for update;
  -- null is an explicit not-a-certified-transfer result for the shared router.
  if not found then return null; end if;
  if p_group_id is not null and p_group_id<>v_op.request_id then
    raise exception 'El movimiento no pertenece al grupo seleccionado.' using errcode='22023';
  end if;
  v_ids:=array_remove(array[v_op.source_movement_id,v_op.target_movement_id,v_op.fee_movement_id],null);
  perform id from public.money_accounts where id in (select money_account_id from public.money_movements where id=any(v_ids)) order by id for update;
  perform id from public.money_movements where id=any(v_ids) order by id for update;
  if not exists(select 1 from public.money_movements where id=any(v_ids) and status<>'voided') then
    return jsonb_build_object('movementIds',v_ids,'replayed',true);
  end if;
  if exists(select 1 from public.money_movements where id=any(v_ids) and status<>'confirmed') then
    raise exception 'El traspaso tiene estados inconsistentes; requiere revisión.' using errcode='22023';
  end if;
  update public.money_movements set status='voided',voided_at=v_now,voided_by_user_id=v_uid,void_reason=p_reason,
    reviewed_at=v_now,reviewed_by_user_id=v_uid where id=any(v_ids);
  return jsonb_build_object('movementIds',v_ids,'replayed',false);
end;
$fn$;
create function public.void_money_transfer_v1(p_movement_id bigint,p_group_id uuid,p_reason text)
returns jsonb language sql security invoker set search_path=''
as $fn$ select app_private.void_money_transfer_v1(p_movement_id,p_group_id,p_reason); $fn$;
revoke all on function app_private.void_money_transfer_v1(bigint,uuid,text),public.void_money_transfer_v1(bigint,uuid,text) from public,anon,service_role;
grant execute on function app_private.void_money_transfer_v1(bigint,uuid,text),public.void_money_transfer_v1(bigint,uuid,text) to authenticated;
commit;
