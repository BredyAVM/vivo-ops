-- Preserve actual delivery change in snapshot payment coverage. No money is
-- inserted, no settlement is closed, and function privileges remain unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('public.get_order_financial_state_block3(bigint,date,numeric)'::regprocedure);
  needle text := '(select payout_difference_usd+certified_change_usd from change_accounting) as snapshot_change_usd';
  replacement text := $replacement$(
      (select payout_difference_usd+certified_change_usd from change_accounting)
      + coalesce((select sum(m.amount_usd_equivalent)
        from public.money_movements m
        where m.order_id=p_order_id and m.status='confirmed'
          and m.direction='outflow' and m.movement_type='change_given'
          and exists (select 1 from public.delivery_settlement_entries e
            join public.delivery_settlements s on s.id=e.settlement_id
            where e.money_movement_id=m.id and e.entry_type='cash_change_out'
              and s.order_id=p_order_id)
          -- A certified payment may already include the same change.
          and not exists (select 1 from public.payment_confirmation_operations op
            where op.order_id=p_order_id and op.movement_group_id=m.movement_group_id
              and op.request ? 'expectedChangeDebtUsd')
      ),0)
    ) as snapshot_change_usd$replacement$;
begin
  if strpos(definition,replacement)>0 then return; end if;
  if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then
    raise exception 'Unexpected financial function definition; review delivery change accounting before applying';
  end if;
  execute replace(definition,needle,replacement);
end $migration$;
