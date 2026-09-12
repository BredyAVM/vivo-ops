set lock_timeout = '5s';
set statement_timeout = '30s';

begin;

-- Keep customer, assigned advisor, product, quantity, price, selection and
-- lifecycle guards unchanged. Master/admin may operate on the advisor's behalf.
do $migration$
declare
  definition text := pg_catalog.pg_get_functiondef('app_private.crm_order_item_guard_v1()'::regprocedure);
  previous_check text := $check$and caller_id is distinct from order_row.attributed_advisor_id
    then$check$;
  next_check text := $check$and caller_id is distinct from order_row.attributed_advisor_id
      and not public.is_master_or_admin()
    then$check$;
begin
  if pg_catalog.strpos(definition, previous_check) = 0 then
    raise exception 'The CRM actor guard changed; review before applying this migration.';
  end if;
  definition := pg_catalog.replace(definition, previous_check, next_check);
  definition := pg_catalog.replace(definition,
    'Solo el asesor adjudicado puede aplicar este beneficio.',
    'Solo el asesor adjudicado, master o administrador pueden aplicar este beneficio.');
  execute definition;
end;
$migration$;

commit;
