-- Permite que un asesor guarde/recalcule items de sus propias ordenes.
-- Esta politica corrige el bloqueo RLS al reinsertar order_items desde el modulo advisor.

alter table public.order_items enable row level security;

drop policy if exists "Advisors can insert own order items" on public.order_items;

create policy "Advisors can insert own order items"
on public.order_items
for insert
to authenticated
with check (
  exists (
    select 1
    from public.orders o
    where o.id = order_items.order_id
      and o.attributed_advisor_id = auth.uid()
      and o.status <> 'cancelled'
  )
  and exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'advisor'
  )
);
