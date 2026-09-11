begin;

update public.order_items item
set
  sku_snapshot = product.sku,
  product_name_snapshot = product.name
from public.orders order_data,
  public.products product,
  public.crm_play_redemptions redemption,
  public.crm_play_benefits benefit,
  public.crm_plays play
where order_data.order_number = 'VO-20260911-0265'
  and item.order_id = order_data.id
  and redemption.order_item_id = item.id
  and redemption.order_id = order_data.id
  and benefit.id = redemption.play_benefit_id
  and play.id = benefit.play_id
  and play.name = 'Aniversario · septiembre de 2026'
  and product.id = item.product_id
  and product.sku = 'SINGLE_6'
  and (
    item.sku_snapshot is distinct from product.sku
    or item.product_name_snapshot is distinct from product.name
  );

commit;
