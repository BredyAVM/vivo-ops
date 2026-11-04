-- Targeted restoration of the advisor proven by the pre-edit timeline.
-- Defaults to ROLLBACK. Do not apply this rule to other historical orders.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '25s';

do $repair$
declare
  original_advisor constant uuid := '8c296814-8b98-48d4-8db1-ce27b4c808eb';
  editor constant uuid := '833e2079-6bc7-4708-aa9f-1b25ac20a911';
  repair_key constant text := 'restore-3777-advisor-after-operational-edit';
  why constant text := 'Se restituye el asesor original de la orden. Una edición operativa sustituyó la atribución por el usuario que guardó.';
  o public.orders%rowtype;
  event_id bigint;
  evidence jsonb;
  items jsonb;
  inventory jsonb;
  client_row jsonb;
  finance jsonb;
begin
  perform set_config('request.jwt.claim.sub', original_advisor::text, true);
  if public.is_admin() is not true then raise exception 'Expected administrative repair context.'; end if;
  select * into strict o from public.orders where id=3777 for update;
  if o.attributed_advisor_id=original_advisor and exists(select 1 from public.order_admin_adjustments
    where order_id=o.id and payload->>'repair_key'=repair_key) then return; end if;
  if o.created_by_user_id is distinct from original_advisor
    or o.attributed_advisor_id is distinct from editor or o.source::text<>'master'
    or o.status::text<>'delivered' or o.total_usd<>74.50
    or o.last_modified_at is distinct from '2026-11-03T19:52:54.954402Z'::timestamptz then
    raise exception 'Order baseline changed; review before retrying.';
  end if;
  if not exists(select 1 from public.order_timeline_event_recipients r join public.order_timeline_events e on e.id=r.event_id
    where e.id=36571 and e.order_id=o.id and e.event_type='order_approved' and r.target_user_id=original_advisor)
    or not exists(select 1 from public.order_timeline_events e where e.id=36572 and e.order_id=o.id and e.actor_user_id=editor
      and e.payload->'change_summary' ? 'Se cambió el asesor.') then
    raise exception 'Required attribution evidence is missing.';
  end if;
  if exists(select 1 from public.order_items where order_id=o.id and (crm_play_member_id is not null or reward_grant_id is not null))
    or exists(select 1 from public.order_admin_adjustments where order_id=o.id and payload->>'kind'='advisor_change')
    or exists(select 1 from public.advisor_commission_closures where advisor_user_id in (original_advisor,editor) and snapshot::text ~ '\m3777\M') then
    raise exception 'Linked benefit, explicit adjustment or commission snapshot requires review.';
  end if;

  select jsonb_agg(to_jsonb(i) order by id) into items from public.order_items i where order_id=o.id;
  select jsonb_agg(to_jsonb(m) order by id) into inventory from public.inventory_movements m where order_id=o.id;
  select to_jsonb(c) into client_row from public.clients c where id=o.client_id;
  select to_jsonb(f) into strict finance from public.get_order_financial_state(o.id) f;
  evidence:=jsonb_build_object('kind','advisor_change','repair_key',repair_key,'source','historical_attribution_repair',
    'previous_advisor_user_id',editor,'next_advisor_user_id',original_advisor,
    'evidence_event_ids',jsonb_build_array(36569,36570,36571,36572));
  update public.orders set attributed_advisor_id=original_advisor,last_modified_by=original_advisor,
    last_modified_at=clock_timestamp() where id=o.id;
  insert into public.order_admin_adjustments(order_id,adjustment_type,reason,payload,created_by_user_id)
    values(o.id,'other',why,evidence,original_advisor);
  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)
    values(o.id,o.order_number,'order_advisor_assigned','assignment','Asesor original restituido',why,'info',original_advisor,evidence)
    returning id into event_id;
  insert into public.order_timeline_event_recipients(event_id,target_user_id,requires_action)
    values(event_id,original_advisor,false);
  set constraints all immediate;
  if (select to_jsonb(n)-'attributed_advisor_id'-'last_modified_at'-'last_modified_by' from public.orders n where id=o.id)
    is distinct from (to_jsonb(o)-'attributed_advisor_id'-'last_modified_at'-'last_modified_by')
    or (select attributed_advisor_id from public.orders where id=o.id) is distinct from original_advisor
    or (select to_jsonb(c) from public.clients c where id=o.client_id) is distinct from client_row
    or (select jsonb_agg(to_jsonb(i) order by id) from public.order_items i where order_id=o.id) is distinct from items
    or (select jsonb_agg(to_jsonb(m) order by id) from public.inventory_movements m where order_id=o.id) is distinct from inventory
    or (select to_jsonb(f) from public.get_order_financial_state(o.id) f) is distinct from finance then
    raise exception 'Unexpected side effect; rolling back.';
  end if;
end $repair$;

select o.id,o.source,o.status,o.total_usd,p.full_name as advisor
from public.orders o join public.profiles p on p.id=o.attributed_advisor_id where o.id=3777;
rollback;
