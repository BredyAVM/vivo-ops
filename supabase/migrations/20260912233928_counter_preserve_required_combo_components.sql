-- An inactive standalone product can still be a required component of an
-- active combo. Preserve that composition in both Counter's catalog and writer.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  v_definition text;
  v_fragment text;
begin
  v_definition := pg_catalog.pg_get_functiondef('public.counter_read_catalog()'::regprocedure);
  v_fragment := 'or coalesce(component.extra_fields ->> ''inventory_component_only'', ''false'') = ''true''';
  if pg_catalog.strpos(v_definition, v_fragment) = 0 then
    raise exception 'Unexpected counter_read_catalog component predicate';
  end if;
  execute pg_catalog.replace(v_definition, v_fragment,
    v_fragment || E'\n           or (pc.component_mode = ''fixed'' and pc.is_required = true)');

  v_definition := pg_catalog.pg_get_functiondef(
    'public.counter_direct_sale_item_notes(bigint,numeric,text,jsonb)'::regprocedure
  );
  v_fragment := 'and component.is_active = true';
  if (length(v_definition) - length(replace(v_definition, v_fragment, ''))) / length(v_fragment) <> 2 then
    raise exception 'Unexpected counter_direct_sale_item_notes component predicates';
  end if;
  execute pg_catalog.replace(v_definition, v_fragment,
    'and (component.is_active = true or (pc.component_mode = ''fixed'' and pc.is_required = true))');
end;
$migration$;

-- Existing function signatures, role checks, search paths and grants remain intact.
commit;
