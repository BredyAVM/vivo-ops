-- Block 6 post-apply hardening found by the Supabase advisors.

set lock_timeout = '5s';
set statement_timeout = '30s';

revoke select on table public.order_item_components from anon;

drop policy if exists order_item_components_select_authenticated
  on public.order_item_components;

create policy order_item_components_select_by_operational_role
on public.order_item_components
for select
to authenticated
using (
  exists (
    select 1
    from public.user_roles role_row
    where role_row.user_id = (select auth.uid())
      and role_row.role in (
        'admin'::public.user_role,
        'master'::public.user_role,
        'kitchen'::public.user_role,
        'counter'::public.user_role
      )
  )
  or (
    exists (
      select 1
      from public.user_roles role_row
      where role_row.user_id = (select auth.uid())
        and role_row.role = 'advisor'::public.user_role
    )
    and exists (
      select 1
      from public.order_items order_item
      join public.orders order_row on order_row.id = order_item.order_id
      where order_item.id = order_item_components.order_item_id
        and order_row.attributed_advisor_id = (select auth.uid())
    )
  )
);

create index order_item_components_component_product_id_idx
  on public.order_item_components (component_product_id);
