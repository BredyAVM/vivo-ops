-- Counter Block 8 hardening: make functional search indexes usable without
-- coupling every query branch to a partial-index predicate.

begin;

drop index if exists public.clients_counter_phone_digits_trgm_idx;
drop index if exists public.orders_receiver_name_search_norm_trgm_idx;
drop index if exists public.orders_receiver_phone_digits_trgm_idx;

create index clients_counter_phone_digits_trgm_idx
  on public.clients
  using gin (public.counter_phone_digits(phone) gin_trgm_ops);

create index orders_receiver_name_search_norm_trgm_idx
  on public.orders
  using gin (public.search_normalize(receiver_name) gin_trgm_ops);

create index orders_receiver_phone_digits_trgm_idx
  on public.orders
  using gin (public.counter_phone_digits(receiver_phone) gin_trgm_ops);

commit;
