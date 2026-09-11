-- Run inside BEGIN ... ROLLBACK only. No real orders or stock writes.
select set_config('request.jwt.claim.sub',(select user_id::text from public.user_roles where role='admin' limit 1),true);
insert into public.orders(id,order_number,source,fulfillment,status,extra_fields)
values(9000000220,'ROLLBACK-PACK-DETAIL','master','pickup','created','{}');
insert into public.order_items(id,order_id,product_id,qty,unit_price_usd_snapshot,line_total_usd,product_name_snapshot,notes)
select 9000000220,9000000220,id,1,base_price_usd,base_price_usd,name,E'6 Mini Tequeños Fritos\n1 Salsa Tártara 1oz'
from public.products where sku='SINGLE_6';
do $$ declare result jsonb; begin
  result:=app_private.inventory_order_sale_diagnostics_v1(9000000220);
  assert exists(select 1 from jsonb_array_elements(result->'errors') e where e->>'code'='component_without_resolution'), 'text-only regression reproduced';
end $$;
update public.order_items set notes=E'6 Mini Tequeños Fritos\n@sel|5|6\n1 Salsa Tártara 1oz\n@sel|2|1'
where id=9000000220;
do $$ declare result jsonb; begin
  result:=app_private.inventory_order_sale_diagnostics_v1(9000000220);
  assert jsonb_array_length(result->'errors')=0, 'saved selections resolve without approval error';
  assert (select notes like '%@sel|5|6%' from public.order_items where id=9000000220), 'CRM guard preserves inventory markers';
  assert not exists(select 1 from public.inventory_movements where order_id=9000000220), 'diagnosis never deducts stock';
end $$;
select 'PASS: reproduced missing selections; preserved notes resolve; no stock movement' as result;
