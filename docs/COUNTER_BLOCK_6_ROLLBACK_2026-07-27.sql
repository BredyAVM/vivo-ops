-- Counter Block 6 emergency rollback.
--
-- Revert the Counter application code first. This rollback intentionally stops
-- if any delivery settlement exists because custody and money must never be
-- discarded to force a schema rollback.

begin;

do $guard$
begin
  if exists (select 1 from public.delivery_settlements)
     or exists (
       select 1
       from public.order_change_obligations
       where delivery_settlement_id is not null
          or delivery_settlement_entry_id is not null
     ) then
    raise exception
      'Block 6 has delivery custody data. Reconcile and preserve it before rollback.';
  end if;
end;
$guard$;

drop function public.counter_read_delivery_settlement_detail(bigint, bigint);

drop function public.counter_complete_delivery_change_obligation(
  uuid,
  bigint,
  bigint,
  date,
  text,
  text
);

grant execute on function public.counter_complete_delivery_digital_change(
  uuid,
  bigint,
  jsonb,
  text
) to authenticated, service_role;

drop function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
);

drop function public.counter_dispatch_delivery_block6_v1(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
);

alter function public.counter_dispatch_delivery_block2(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) rename to counter_dispatch_delivery;

grant execute on function public.counter_dispatch_delivery(
  uuid,
  bigint,
  integer,
  jsonb,
  jsonb,
  jsonb,
  text
) to authenticated, service_role;

drop index public.order_change_obligations_delivery_entry_uk;
drop index public.order_change_obligations_delivery_settlement_idx;

alter table public.order_change_obligations
  drop constraint order_change_obligations_delivery_link_ck,
  drop column delivery_settlement_entry_id,
  drop column delivery_settlement_id;

drop index public.delivery_settlement_entries_source_line_uk;

alter table public.delivery_settlement_entries
  drop constraint delivery_settlement_entries_source_line_key_ck,
  drop column source_line_key;

grant select on table public.delivery_settlements
  to authenticated;
grant select on table public.delivery_settlement_entries
  to authenticated;

commit;
