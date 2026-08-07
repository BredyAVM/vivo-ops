-- Inventory is an authenticated operational domain. Anonymous discovery/read
-- grants were inherited from the original schema and are not used by Vivo Ops.
set lock_timeout = '5s';
set statement_timeout = '30s';

revoke all privileges on table
  public.inventory_items,
  public.inventory_movements,
  public.inventory_recipes,
  public.inventory_recipe_components,
  public.product_inventory_links,
  public.inventory_counts,
  public.inventory_count_lines,
  public.inventory_lots,
  public.inventory_item_presentations,
  public.inventory_planned_flows
from anon;
