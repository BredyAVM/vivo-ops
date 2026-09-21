-- Phase 1 of the advisor commission policy, effective in Septiembre 02.
-- Preserve the previous catalog terms as a dated baseline so recalculating an
-- earlier period cannot reinterpret its orders with the new policy.

with target_products(sku, inventory_group, commission_pct, policy_label) as (
  values
    ('SAL_TAR_1OZ', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('SAL_TAR_2OZ', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('SAL_TAR_5OZ', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('SAL_TAR_GALON', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('MM_2OZ', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('MM_5OZ', 'sauces', 5::numeric, 'Salsas y aderezos: 5% fijo'),
    ('PEPSI_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('PEPSI_1000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('PEPSI_2000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('PEPSI_LAT', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('MALTA_LAT', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('YUK_MAN_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('YUK_NAR_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('YUK_PER_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('LIP_DUR_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('LIP_LIM_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_1000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_2000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_LAT', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('CHIN_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('CHIN_2000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('FRESC_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('FRESC_2000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_ZERO_1000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_ZERO_2000', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('JDV_1500', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('COKE_1500MAYOR', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('YUKYPACK', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('FANTA_15LT', 'beverages', 5::numeric, 'Bebidas: 5% fijo'),
    ('DEL_Z1', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z2', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z3', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z4', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z5', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z6', 'other', 0::numeric, 'Delivery: sin comisión'),
    ('DEL_Z7', 'other', 0::numeric, 'Delivery: sin comisión')
)
update public.products as product
set
  commission_mode = 'fixed_item',
  commission_value = target.commission_pct,
  commission_notes = target.policy_label || ' desde Septiembre 02 (16/09/2026).',
  inventory_group = target.inventory_group,
  extra_fields = jsonb_set(
    coalesce(product.extra_fields, '{}'::jsonb),
    '{commission_schedule_v1}',
    jsonb_build_array(
      jsonb_build_object(
        'effective_from', '1900-01-01',
        'mode', coalesce(product.commission_mode, 'default'),
        'value', product.commission_value,
        'reason', 'Condición histórica anterior a Septiembre 02'
      ),
      jsonb_build_object(
        'effective_from', '2026-09-16',
        'mode', 'fixed_item',
        'value', target.commission_pct,
        'reason', target.policy_label
      )
    ),
    true
  )
from target_products as target
where product.sku = target.sku
  and product.is_active = true;
