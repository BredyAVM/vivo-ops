-- PostgreSQL treats LEAST as conditional syntax, not as a pg_catalog function.
-- Replace the qualified spelling in the just-installed monitor definition.

do $fix$
declare
  function_definition text;
begin
  function_definition := pg_catalog.pg_get_functiondef(
    'public.crm_get_play_monitor_summary_v2(bigint)'::regprocedure
  );
  function_definition := pg_catalog.replace(
    function_definition,
    'pg_catalog.least(',
    'least('
  );
  execute function_definition;
end;
$fix$;
