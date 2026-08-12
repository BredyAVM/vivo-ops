begin;

do $migration$
declare
  v_definition text;
begin
  select pg_get_functiondef(
    'public.inventory_request_supplemental_recount_v1(bigint,bigint[],text)'::regprocedure
  )
  into v_definition;

  v_definition := replace(v_definition, 'AutenticaciÃ³n', 'Autenticación');
  v_definition := replace(v_definition, 'MÃ¡ster', 'Máster');
  v_definition := replace(v_definition, 'AdministraciÃ³n', 'Administración');
  v_definition := replace(v_definition, 'Ã­tem', 'ítem');
  v_definition := replace(v_definition, 'Ã­tems', 'ítems');
  v_definition := replace(v_definition, 'lÃ­nea', 'línea');
  v_definition := replace(v_definition, 'mÃ¡s', 'más');
  v_definition := replace(v_definition, 'estÃ¡n', 'están');

  if position('Ã' in v_definition) > 0 then
    raise exception 'Quedaron caracteres mal codificados en la función de reconteo complementario.';
  end if;

  execute v_definition;
end;
$migration$;

comment on function public.inventory_request_supplemental_recount_v1(bigint, bigint[], text) is
  'Extiende un reconteo abierto o crea uno complementario vinculado, con mensajes UTF-8 normalizados.';

commit;
