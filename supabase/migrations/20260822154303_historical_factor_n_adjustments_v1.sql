-- The legacy workbook records its FACTOR N commercial discount as a negative
-- detail row. It is part of Total a Pagar, not a client balance or debt.

alter table public.historical_order_items
  drop constraint historical_order_items_unit_price_check,
  drop constraint historical_order_items_line_total_check;

alter table public.historical_order_items
  add constraint historical_order_items_commercial_amount_check
  check (
    (unit_price_usd >= 0 and line_total_usd >= 0)
    or (
      product_id is null
      and legacy_product_code = 'COD341'
      and upper(btrim(product_name_snapshot)) = 'FACTOR N'
      and unit_price_usd = -1
      and line_total_usd < 0
      and abs(line_total_usd - round(quantity * unit_price_usd, 2)) < 0.005
    )
  );

comment on constraint historical_order_items_commercial_amount_check
on public.historical_order_items is
  'Allows only the workbook FACTOR N negative commercial adjustment; historical balances and debt are never imported.';
