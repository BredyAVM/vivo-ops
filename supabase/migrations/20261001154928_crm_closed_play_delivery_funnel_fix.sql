-- Preserve frozen campaign decisions. Only the automatic funnel projection of an
-- evidenced delivery may update its six operational fields after campaign closure.
-- No order is delivered and no exception is granted by this migration.
-- Version synchronized with the applied managed migration.
do $patch$
declare
  source text;
  anchor text;
begin
  source := pg_get_functiondef('app_private.crm_play_member_guard_v1()'::regprocedure);
  anchor := '  play_status text;';
  if strpos(source,anchor)=0 then raise exception 'Member guard declaration changed'; end if;
  source := replace(source,anchor,anchor || E'\n  funnel_time timestamptz;');
  anchor := '  if tg_op = ''UPDATE'' and lifecycle_context = ''on'' then';
  if strpos(source,anchor)=0 then raise exception 'Member lifecycle guard changed'; end if;
  source := replace(source,anchor,$guard$
  if tg_op = 'UPDATE' and coalesce(pg_catalog.current_setting('app.crm_redemption_funnel_event',true),'') <> '' then
    if pg_catalog.pg_trigger_depth() < 2 or play_status not in ('active','closed')
      or old.benefit_status <> 'redeemed' then
      raise exception 'El seguimiento automático requiere una entrega CRM comprobada.' using errcode='42501';
    end if;
    select event.created_at into funnel_time
    from public.crm_play_member_events event
    where event.id::text = pg_catalog.current_setting('app.crm_redemption_funnel_event',true)
      and event.play_member_id = old.id and event.event_type = 'benefit_redeemed'
      and exists (
        select 1 from public.crm_play_redemptions redemption
        join public.orders order_row on order_row.id = redemption.order_id
        where redemption.play_member_id = old.id and redemption.status = 'redeemed'
          and order_row.status = 'delivered'
          and redemption.redeemed_at = event.created_at
          and redemption.redeemed_by_user_id = event.actor_user_id
      );
    if not found then
      raise exception 'El seguimiento automático requiere una entrega CRM comprobada.' using errcode='42501';
    end if;
    if (pg_catalog.to_jsonb(new) - 'updated_at') is distinct from
      ((pg_catalog.to_jsonb(old) - 'updated_at') || pg_catalog.jsonb_build_object(
        'contacted_at',coalesce(old.contacted_at,funnel_time),
        'responded_at',coalesce(old.responded_at,funnel_time),
        'play_launched_at',coalesce(old.play_launched_at,funnel_time),
        'last_contact_at',greatest(old.last_contact_at,funnel_time),
        'contact_attempt_count',greatest(old.contact_attempt_count,1),
        'last_event_at',greatest(old.last_event_at,funnel_time))) then
      raise exception 'El seguimiento automático no puede alterar la selección ni los datos congelados.' using errcode='42501';
    end if;
    return new;
  end if;

$guard$ || anchor);
  execute source;

  source := pg_get_functiondef('app_private.crm_infer_play_funnel_from_redemption_v1()'::regprocedure);
  anchor := E'begin\n  update public.crm_play_members member';
  if strpos(source,anchor)=0 then raise exception 'Redemption funnel function changed'; end if;
  source := replace(source,anchor,$funnel$declare
  previous_context text := coalesce(pg_catalog.current_setting('app.crm_redemption_funnel_event',true),'');
begin
  perform pg_catalog.set_config('app.crm_redemption_funnel_event',new.id::text,true);
  update public.crm_play_members member$funnel$);
  anchor := '  return new;';
  if strpos(source,anchor)=0 then raise exception 'Redemption funnel return changed'; end if;
  source := replace(source,anchor,
    '  perform pg_catalog.set_config(''app.crm_redemption_funnel_event'',previous_context,true);' || E'\n' || anchor);
  execute source;
end;
$patch$;

revoke all on function app_private.crm_infer_play_funnel_from_redemption_v1() from public,anon,authenticated;
revoke all on function app_private.crm_play_member_guard_v1() from public,anon,authenticated;
