-- Minimal dependencies for exercising the unchanged production reservation/dispatch functions.
create domain public.user_role as text;
alter table public.orders add column needs_reapproval boolean default false,add column queued_needs_reapproval boolean default false,
 add column fulfillment text default 'delivery',add column source text default 'advisor',
 add column last_modified_by uuid default '00000000-0000-4000-8000-000000000001',add column sent_to_kitchen_by uuid,add column created_by_user_id uuid;
create table public.inventory_planned_flows(id bigint generated always as identity,inventory_item_id bigint,flow_type text,quantity_units numeric,
 effective_at timestamptz,status text,order_id bigint,inventory_recipe_id bigint,depends_on_flow_id bigint,notes text,created_by_user_id uuid);
create table public.inventory_movements(id bigint generated always as identity,inventory_item_id bigint,movement_type text,quantity_units numeric,
 reason_code text,notes text,order_id bigint,operation_id uuid,reversal_of_movement_id bigint,created_by_user_id uuid,created_at timestamptz default now());
create function app_private.inventory_product_routes_v1(bigint)returns jsonb language sql as $$select '[]'::jsonb$$;
create function app_private.inventory_resolve_commitment_actor_v1(bigint,uuid)returns uuid language sql as $$select $2$$;
create function app_private.inventory_order_effective_at_v1(bigint)returns timestamptz language sql as $$select now()$$;
create function app_private.inventory_close_order_commitments_v1(bigint,text,uuid)returns integer language plpgsql as $$declare n integer;begin
 update public.inventory_planned_flows set status=$2 where order_id=$1 and status in('active','draft');get diagnostics n=row_count;return n;end$$;
create function app_private.inventory_item_is_initialized_v1(bigint)returns boolean language sql as $$select true$$;
create function app_private.inventory_apply_delta_v1(uuid,bigint,text,numeric,text,text,bigint,bigint,uuid,bigint)returns void language plpgsql as $$begin
 update public.inventory_items set current_stock_units=current_stock_units+$4 where id=$2;
 insert into public.inventory_movements(operation_id,inventory_item_id,movement_type,quantity_units,reason_code,notes,order_id,reversal_of_movement_id,created_by_user_id)
 values($1,$2,$3,$4,$5,$6,$7,$8,$9);end$$;
create function app_private.inventory_operation_result_v1(uuid)returns jsonb language sql as $$select jsonb_build_object('operation_id',$1,'line_count',count(*))from public.inventory_movements where operation_id=$1$$;
