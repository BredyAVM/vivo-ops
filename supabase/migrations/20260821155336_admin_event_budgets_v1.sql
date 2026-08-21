-- Administrative event budgets reuse advisor_order_drafts, order items,
-- product components and the existing administrative adjustment ledger.
-- The only new persisted fact is the preparation route selected for each
-- component frozen into an order.

alter table public.order_item_components
  add column if not exists preparation_mode text not null default 'kitchen';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.order_item_components'::regclass
      and conname = 'order_item_components_preparation_mode_check'
  ) then
    alter table public.order_item_components
      add constraint order_item_components_preparation_mode_check
      check (preparation_mode in ('kitchen', 'on_site', 'not_applicable'))
      not valid;
  end if;
end;
$$;

alter table public.order_item_components
  validate constraint order_item_components_preparation_mode_check;

comment on column public.order_item_components.preparation_mode is
  'Frozen preparation route for an order component: kitchen, on_site or not_applicable.';

-- Admin owns event budgets but the assigned advisor can keep using the
-- existing own-draft policies. No parallel quote table is introduced.
drop policy if exists advisor_order_drafts_select_admin
  on public.advisor_order_drafts;
create policy advisor_order_drafts_select_admin
on public.advisor_order_drafts
for select
to authenticated
using ((select public.has_role('admin')));

drop policy if exists advisor_order_drafts_insert_admin
  on public.advisor_order_drafts;
create policy advisor_order_drafts_insert_admin
on public.advisor_order_drafts
for insert
to authenticated
with check ((select public.has_role('admin')));

drop policy if exists advisor_order_drafts_update_admin
  on public.advisor_order_drafts;
create policy advisor_order_drafts_update_admin
on public.advisor_order_drafts
for update
to authenticated
using ((select public.has_role('admin')))
with check ((select public.has_role('admin')));

drop policy if exists advisor_order_drafts_delete_admin
  on public.advisor_order_drafts;
create policy advisor_order_drafts_delete_admin
on public.advisor_order_drafts
for delete
to authenticated
using ((select public.has_role('admin')));

-- Keep the legacy catalog row as an internal order carrier. It remains active
-- so an accepted event can be edited operationally, but normal catalog pickers
-- must hide rows with this scope.
update public.products
set extra_fields = coalesce(extra_fields, '{}'::jsonb) || jsonb_build_object(
  'catalog_access_scope', 'admin_internal',
  'event_budget_template', true,
  'event_budget_schema_version', 1
)
where sku = 'PACK_EVENTO';

-- Preparation markers live beside the already canonical @sel markers in the
-- order item snapshot. This second non-blocking trigger runs after component
-- snapshots have been rebuilt and restores their preparation routes.
create or replace function app_private.inventory_apply_component_preparation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.order_item_components component
  set preparation_mode = 'kitchen'
  where component.order_item_id = new.id;

  update public.order_item_components component
  set preparation_mode = terms.preparation_mode
  from (
    select
      (entry.value ->> 'product_id')::bigint as component_product_id,
      entry.value ->> 'preparation_mode' as preparation_mode
    from (
      select adjustment.payload
      from public.order_admin_adjustments adjustment
      where adjustment.order_item_id = new.id
        and adjustment.adjustment_type = 'other'
        and adjustment.payload ->> 'kind' = 'event_commercial_terms'
      order by adjustment.created_at desc, adjustment.id desc
      limit 1
    ) adjustment
    cross join lateral jsonb_array_elements(
      coalesce(adjustment.payload -> 'components', '[]'::jsonb)
    ) entry(value)
    where entry.value ->> 'preparation_mode' in ('kitchen', 'on_site', 'not_applicable')
  ) terms
  where component.order_item_id = new.id
    and component.component_product_id = terms.component_product_id;

  update public.order_item_components component
  set preparation_mode = marker.preparation_mode
  from (
    select
      pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint as component_product_id,
      max(pg_catalog.split_part(btrim(split_line.line), '|', 3)) as preparation_mode
    from pg_catalog.regexp_split_to_table(
      coalesce(new.notes, ''),
      E'\\r?\\n'
    ) split_line(line)
    where btrim(split_line.line)
      ~ E'^@prep\\|[1-9][0-9]*\\|(kitchen|on_site|not_applicable)$'
    group by pg_catalog.split_part(btrim(split_line.line), '|', 2)::bigint
  ) marker
  where component.order_item_id = new.id
    and component.component_product_id = marker.component_product_id;

  return new;
exception when others then
  -- Inventory is observational during the current rollout and must never
  -- prevent an order from being created or edited.
  return new;
end;
$$;

revoke all on function app_private.inventory_apply_component_preparation_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists inventory_15_event_component_preparation_v1
  on public.order_items;
create trigger inventory_15_event_component_preparation_v1
after insert or update of product_id, qty, notes
on public.order_items
for each row
execute function app_private.inventory_apply_component_preparation_v1();

comment on function app_private.inventory_apply_component_preparation_v1() is
  'Non-blocking projection of @prep markers into frozen order component snapshots.';
