-- Block 18 follow-up: retire the canonical link of the inactive historical
-- Yukipack product. The version 0 legacy link and all order history remain.

set lock_timeout = '5s';
set statement_timeout = '30s';

select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('vivo_inventory_block_18_catalog', 0)
);

do $$
begin
  if exists (
    select 1
    from public.orders order_row
    join public.order_items order_item on order_item.order_id = order_row.id
    join public.products product on product.id = order_item.product_id
    where product.sku = 'GAMBIT_YUKIPACK'
      and order_row.status::text not in ('delivered', 'cancelled')
  ) then
    raise exception 'Block 18 cleanup stopped: the retired Yukipack product has an open order.';
  end if;
end;
$$;

delete from public.product_inventory_links link
using public.products product
where link.product_id = product.id
  and product.sku = 'GAMBIT_YUKIPACK'
  and not product.is_active
  and link.configuration_version = 1;

do $$
begin
  if exists (
    select 1
    from public.product_inventory_links link
    join public.products product on product.id = link.product_id
    where product.sku = 'GAMBIT_YUKIPACK'
      and not product.is_active
      and link.configuration_version = 1
  ) then
    raise exception 'Block 18 cleanup stopped: the retired canonical link remains.';
  end if;

  if not exists (
    select 1
    from public.product_inventory_links link
    join public.products product on product.id = link.product_id
    where product.sku = 'GAMBIT_YUKIPACK'
      and not product.is_active
      and link.configuration_version = 0
  ) then
    raise exception 'Block 18 cleanup stopped: historical legacy compatibility was lost.';
  end if;
end;
$$;
