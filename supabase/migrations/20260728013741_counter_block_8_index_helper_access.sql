-- Counter Block 8 hardening: expression-index helpers must remain executable by
-- authenticated writers whose permitted client/order updates maintain indexes.

begin;

grant execute on function public.counter_phone_digits(text)
  to authenticated, service_role;

commit;
