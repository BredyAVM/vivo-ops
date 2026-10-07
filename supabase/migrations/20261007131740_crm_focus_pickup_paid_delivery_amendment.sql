-- One-off, administrator-authorized amendment. No permanent relaxation of
-- published-play immutability; no audience, financial or lifecycle mutation.
do $amend$
declare
  target public.crm_plays%rowtype;
  previous jsonb;
  current_values jsonb;
  original_guard text;
  temporary_guard text;
  allowance text := $allow$
  if current_user = 'postgres'
    and pg_catalog.current_setting('app.crm_play_amendment_context', true) = 'focus_pickup_paid_delivery_20261007'
    and old.name = 'Focus Pickup · octubre de 2026'
    and old.starts_at = '2026-10-03T04:00:00Z'::timestamptz
    and old.status = 'active' and new.status = 'active'
    and old.benefit_fulfillment = 'pickup' and new.benefit_fulfillment = 'any'
    and (to_jsonb(new) - array['benefit_fulfillment','description','advisor_guidance','message_template','updated_at'])
      = (to_jsonb(old) - array['benefit_fulfillment','description','advisor_guidance','message_template','updated_at'])
  then
    return new;
  end if;
$allow$;
begin
  if current_user <> 'postgres' then
    raise exception 'This audited one-off amendment requires the migration owner';
  end if;
  -- Lock only the intended published campaign; concurrent edits must complete first.
  select * into strict target from public.crm_plays
  where name = 'Focus Pickup · octubre de 2026'
    and starts_at = '2026-10-03T04:00:00Z'::timestamptz
  for update;
  if target.status <> 'active' or target.benefit_fulfillment <> 'pickup'
    or target.benefit_recurrence_mode <> 'daily'
    or target.purchase_requirement_mode <> 'minimum_order'
    or target.minimum_order_amount_usd <> 10
    or target.ends_at <> '2026-11-01T03:59:59.999Z'::timestamptz then
    raise exception 'Focus Pickup terms changed; review before applying the amendment';
  end if;
  if position('y la retires en nuestro local' in target.message_template) = 0 then
    raise exception 'Focus Pickup message changed; review the approved wording';
  end if;
  previous := jsonb_build_object('benefit_fulfillment',target.benefit_fulfillment,
    'description',target.description,'advisor_guidance',target.advisor_guidance,
    'message_template',target.message_template);
  original_guard := pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure);
  if position(E'begin\n' in original_guard) = 0 then
    raise exception 'Published-play guard changed; cannot safely scope amendment';
  end if;
  temporary_guard := replace(original_guard,E'begin\n',E'begin\n' || allowance);
  perform set_config('app.crm_play_amendment_context','focus_pickup_paid_delivery_20261007',true);
  execute temporary_guard;
  update public.crm_plays set
    benefit_fulfillment = 'any',
    description = replace(description,'Dondy por compra pickup mínima $10.',
      'Dondy por compra mínima $10 en productos, con retiro o delivery; el cliente paga el envío habitual.'),
    advisor_guidance = replace(replace(advisor_guidance,
      'compra pickup elegible','compra elegible (retiro o delivery con envío pagado por el cliente)'),
      'productos para retirar en el local','productos, con retiro o delivery pagado por el cliente')
      || E'\n\nAJUSTE AUTORIZADO 07/10: el Dondy también se permite con delivery. El cliente paga el envío habitual; no incluye delivery gratis. Se mantienen $10 mínimos en productos, un Dondy por cliente por día y vigencia hasta el 31 de octubre.',
    message_template = replace(message_template,
      ' y la retires en nuestro local','')
      || E'\nPuedes retirar tu pedido o coordinar delivery pagando el envío habitual.'
  where id = target.id
  returning jsonb_build_object('benefit_fulfillment',benefit_fulfillment,
    'description',description,'advisor_guidance',advisor_guidance,
    'message_template',message_template) into current_values;
  -- Restore the identical guard before recording the amendment or leaving the transaction.
  execute original_guard;
  perform set_config('app.crm_play_amendment_context','',true);
  insert into public.crm_play_amendments
    (play_id,amendment_type,previous_values,new_values,reason,created_by_user_id)
  values (target.id,'message_updated',previous,current_values,
    'Autorización del administrador: Focus Pickup permite Dondy con delivery pagado por el cliente. Se ajustan canal y texto; se conservan mínimo, recurrencia, vigencia, lista y costos.',
    target.activated_by_user_id);
  if pg_get_functiondef('app_private.crm_play_guard_v1()'::regprocedure) <> original_guard then
    raise exception 'Published-play guard was not restored';
  end if;
end;
$amend$;
