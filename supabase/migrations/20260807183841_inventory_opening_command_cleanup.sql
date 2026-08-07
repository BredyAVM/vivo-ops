-- The canonical opening must always leave an inventory_counts header and its
-- lines. Keep a single authority: inventory_submit_count_v1(count_kind=opening).
set lock_timeout = '5s';
set statement_timeout = '30s';

drop function if exists public.inventory_initialize_stock_v1(uuid, bigint, numeric, text);
