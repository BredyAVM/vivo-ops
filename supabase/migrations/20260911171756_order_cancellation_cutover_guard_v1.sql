-- Apply only after the new Dashboard/Ops server actions are READY in production.
-- Version aligned with the applied post-deployment migration.
begin;
set local lock_timeout='5s';
create or replace function app_private.guard_settled_cancelled_order_v1() returns trigger
language plpgsql security definer set search_path='' as $fn$
begin
 -- Only this transaction can create the protected receipt. Allow its initial
 -- status transition, but no later reopening, repricing or client reassignment.
 if old.status<>'cancelled' and new.status='cancelled' then
   if exists(select 1 from public.order_cancellation_operations where order_id=old.id) then return new; end if;
   if exists(select 1 from public.money_movements where order_id=old.id and status in ('pending','confirmed'))
     or exists(select 1 from public.payment_reports where order_id=old.id and status in ('pending','confirmed'))
     or exists(select 1 from public.client_fund_movements where order_id=old.id)
     or coalesce((old.extra_fields#>>'{payment,client_fund_used_usd}')::numeric,0)<>0 then
     raise exception 'Esta orden tiene dinero involucrado. Cancélala desde Master/Admin para liquidar su saldo.' using errcode='23514';
   end if;
 end if;
 if exists(select 1 from public.order_cancellation_operations where order_id=old.id) and
   (new.status is distinct from old.status or new.client_id is distinct from old.client_id
    or new.total_usd is distinct from old.total_usd or new.total_bs_snapshot is distinct from old.total_bs_snapshot
    or new.extra_fields->'payment' is distinct from old.extra_fields->'payment'
    or new.extra_fields->'pricing' is distinct from old.extra_fields->'pricing') then
   raise exception 'La cancelación ya está liquidada. No se puede reabrir ni modificar su base financiera.' using errcode='23514';
 end if;
 return new;
end $fn$;
revoke all on function app_private.guard_settled_cancelled_order_v1() from public,anon,authenticated,service_role;
commit;
