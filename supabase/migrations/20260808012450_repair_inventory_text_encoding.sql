-- Repair legacy UTF-8 text that was previously interpreted as Windows-1252/Latin-1.
-- The updates are deliberately limited to inventory-domain display text and only
-- touch rows whose value actually changes. No IDs, quantities, policies, or stock
-- balances are modified.

create function app_private.inventory_repair_text_encoding_v1(p_value text)
returns text
language plpgsql
immutable
strict
security invoker
set search_path = ''
as $$
declare
  v_value text := p_value;
begin
  -- Spanish letters encoded once as UTF-8 and decoded once as Latin-1.
  v_value := replace(v_value, U&'\00C3\00A1', U&'\00E1');
  v_value := replace(v_value, U&'\00C3\00A9', U&'\00E9');
  v_value := replace(v_value, U&'\00C3\00AD', U&'\00ED');
  v_value := replace(v_value, U&'\00C3\00B3', U&'\00F3');
  v_value := replace(v_value, U&'\00C3\00BA', U&'\00FA');
  v_value := replace(v_value, U&'\00C3\00B1', U&'\00F1');
  v_value := replace(v_value, U&'\00C3\00BC', U&'\00FC');
  v_value := replace(v_value, U&'\00C3\0081', U&'\00C1');
  v_value := replace(v_value, U&'\00C3\0089', U&'\00C9');
  v_value := replace(v_value, U&'\00C3\008D', U&'\00CD');
  v_value := replace(v_value, U&'\00C3\0093', U&'\00D3');
  v_value := replace(v_value, U&'\00C3\009A', U&'\00DA');
  v_value := replace(v_value, U&'\00C3\0091', U&'\00D1');
  v_value := replace(v_value, U&'\00C3\009C', U&'\00DC');

  -- Common punctuation damaged by the same legacy import path.
  v_value := replace(v_value, U&'\00C2\00B7', U&'\00B7');
  v_value := replace(v_value, U&'\00C2\00BF', U&'\00BF');
  v_value := replace(v_value, U&'\00C2\00A1', U&'\00A1');
  v_value := replace(v_value, U&'\00C2\00B0', U&'\00B0');
  v_value := replace(v_value, U&'\00C3\0097', U&'\00D7');
  v_value := replace(v_value, U&'\00E2\20AC\201D', U&'\2014');
  v_value := replace(v_value, U&'\00E2\20AC\00A6', U&'\2026');
  v_value := replace(v_value, U&'\00E2\2030\00A4', U&'\2264');
  v_value := replace(v_value, U&'\00E2\2020\2019', U&'\2192');

  return v_value;
end;
$$;

revoke all on function app_private.inventory_repair_text_encoding_v1(text)
  from public, anon, authenticated, service_role;

update public.products product
set name = app_private.inventory_repair_text_encoding_v1(product.name),
    sku = app_private.inventory_repair_text_encoding_v1(product.sku),
    commission_notes = app_private.inventory_repair_text_encoding_v1(product.commission_notes),
    inventory_unit_name = app_private.inventory_repair_text_encoding_v1(product.inventory_unit_name),
    packaging_name = app_private.inventory_repair_text_encoding_v1(product.packaging_name),
    extra_fields = app_private.inventory_repair_text_encoding_v1(product.extra_fields::text)::jsonb
where app_private.inventory_repair_text_encoding_v1(product.name) is distinct from product.name
   or app_private.inventory_repair_text_encoding_v1(product.sku) is distinct from product.sku
   or app_private.inventory_repair_text_encoding_v1(product.commission_notes) is distinct from product.commission_notes
   or app_private.inventory_repair_text_encoding_v1(product.inventory_unit_name) is distinct from product.inventory_unit_name
   or app_private.inventory_repair_text_encoding_v1(product.packaging_name) is distinct from product.packaging_name
   or app_private.inventory_repair_text_encoding_v1(product.extra_fields::text) is distinct from product.extra_fields::text;

update public.inventory_items item
set name = app_private.inventory_repair_text_encoding_v1(item.name),
    unit_name = app_private.inventory_repair_text_encoding_v1(item.unit_name),
    packaging_name = app_private.inventory_repair_text_encoding_v1(item.packaging_name),
    notes = app_private.inventory_repair_text_encoding_v1(item.notes)
where app_private.inventory_repair_text_encoding_v1(item.name) is distinct from item.name
   or app_private.inventory_repair_text_encoding_v1(item.unit_name) is distinct from item.unit_name
   or app_private.inventory_repair_text_encoding_v1(item.packaging_name) is distinct from item.packaging_name
   or app_private.inventory_repair_text_encoding_v1(item.notes) is distinct from item.notes;

update public.inventory_item_presentations presentation
set name = app_private.inventory_repair_text_encoding_v1(presentation.name)
where app_private.inventory_repair_text_encoding_v1(presentation.name) is distinct from presentation.name;

update public.inventory_recipes recipe
set notes = app_private.inventory_repair_text_encoding_v1(recipe.notes)
where app_private.inventory_repair_text_encoding_v1(recipe.notes) is distinct from recipe.notes;

update public.product_components component
set notes = app_private.inventory_repair_text_encoding_v1(component.notes)
where app_private.inventory_repair_text_encoding_v1(component.notes) is distinct from component.notes;

update public.product_inventory_links link
set notes = app_private.inventory_repair_text_encoding_v1(link.notes)
where app_private.inventory_repair_text_encoding_v1(link.notes) is distinct from link.notes;

update public.inventory_counts count_header
set notes = app_private.inventory_repair_text_encoding_v1(count_header.notes)
where app_private.inventory_repair_text_encoding_v1(count_header.notes) is distinct from count_header.notes;

update public.inventory_count_lines count_line
set note = app_private.inventory_repair_text_encoding_v1(count_line.note)
where app_private.inventory_repair_text_encoding_v1(count_line.note) is distinct from count_line.note;

update public.inventory_lots lot
set lot_code = app_private.inventory_repair_text_encoding_v1(lot.lot_code),
    notes = app_private.inventory_repair_text_encoding_v1(lot.notes),
    capture_details = app_private.inventory_repair_text_encoding_v1(lot.capture_details::text)::jsonb
where app_private.inventory_repair_text_encoding_v1(lot.lot_code) is distinct from lot.lot_code
   or app_private.inventory_repair_text_encoding_v1(lot.notes) is distinct from lot.notes
   or app_private.inventory_repair_text_encoding_v1(lot.capture_details::text) is distinct from lot.capture_details::text;

update public.inventory_movements movement
set reason_code = app_private.inventory_repair_text_encoding_v1(movement.reason_code),
    notes = app_private.inventory_repair_text_encoding_v1(movement.notes)
where app_private.inventory_repair_text_encoding_v1(movement.reason_code) is distinct from movement.reason_code
   or app_private.inventory_repair_text_encoding_v1(movement.notes) is distinct from movement.notes;

update public.inventory_planned_flows flow
set notes = app_private.inventory_repair_text_encoding_v1(flow.notes),
    capture_details = app_private.inventory_repair_text_encoding_v1(flow.capture_details::text)::jsonb
where app_private.inventory_repair_text_encoding_v1(flow.notes) is distinct from flow.notes
   or app_private.inventory_repair_text_encoding_v1(flow.capture_details::text) is distinct from flow.capture_details::text;

drop function app_private.inventory_repair_text_encoding_v1(text);
