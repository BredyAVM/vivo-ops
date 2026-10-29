-- Fixed USD incentive per burger-containing order. Existing VIVO financial writers are untouched.
begin;
set local lock_timeout='5s';set local statement_timeout='30s';
create function app_private.muerdeme_incentive_admin_v1()returns boolean language sql stable security invoker set search_path=''as $f$
 select (select auth.uid())is not null and(public.has_role('admin')or public.has_role('master'))
 and exists(select 1 from public.profiles where id=(select auth.uid())and is_active);
$f$;
create policy muerdeme_incentive_policy_reader on app_private.commercial_incentive_policy_revisions for select to authenticated
 using((select app_private.muerdeme_order_menu_access_v1()));
create table app_private.muerdeme_order_incentive_terms(
 order_id bigint primary key references public.orders(id),policy_revision integer not null,
 brand_code text not null default 'muerdeme'check(brand_code='muerdeme'),
 advisor_user_id uuid references public.profiles(id),captured_at timestamptz not null default now(),
 foreign key(brand_code,policy_revision)references app_private.commercial_incentive_policy_revisions(brand_code,revision)
);
create index muerdeme_incentive_advisor_idx on app_private.muerdeme_order_incentive_terms(advisor_user_id,order_id);
create index muerdeme_incentive_policy_idx on app_private.muerdeme_order_incentive_terms(brand_code,policy_revision);
alter table app_private.muerdeme_order_incentive_terms enable row level security;
revoke all on app_private.muerdeme_order_incentive_terms from public,anon,authenticated,service_role;
grant select,insert on app_private.muerdeme_order_incentive_terms to authenticated;
create policy muerdeme_incentive_terms_read on app_private.muerdeme_order_incentive_terms for select to authenticated
 using((select app_private.muerdeme_order_reader_v1())and((select app_private.muerdeme_incentive_admin_v1())or advisor_user_id=(select auth.uid())
  or exists(select 1 from public.orders o where o.id=order_id and o.created_by_user_id=(select auth.uid()))));
create policy muerdeme_incentive_terms_insert on app_private.muerdeme_order_incentive_terms for insert to authenticated
 with check((select app_private.muerdeme_order_reader_v1())and exists(select 1 from public.orders o where o.id=order_id
  and(public.has_role('admin')or public.has_role('master')or o.created_by_user_id=(select auth.uid()))));
create function app_private.muerdeme_order_has_burger_v1(p_order bigint)returns boolean language sql stable security invoker set search_path=''as $f$
 select exists(select 1 from app_private.muerdeme_inventory_certificates c join public.order_items i on i.id=c.order_item_id
  where i.order_id=p_order and c.order_id=p_order and c.snapshot->>'status'='ready'
   and exists(select 1 from jsonb_array_elements(c.snapshot->'kitchen')u where u->>'kind'='burger'and(u->>'quantity')::numeric>0));
$f$;
create function app_private.muerdeme_incentive_terms_guard_v1()returns trigger language plpgsql security invoker set search_path=''as $f$
declare o record;r integer;manager uuid;
begin
 if pg_trigger_depth()<2 then raise exception 'Las condiciones se guardan junto con el pedido.'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('commercial-incentive-draft:muerdeme',0));
 select * into o from public.orders where id=new.order_id;
 select max(revision)into r from app_private.commercial_incentive_policy_revisions where brand_code='muerdeme';
 if o.source::text='advisor'and exists(select 1 from public.user_roles where user_id=o.created_by_user_id and role::text='advisor')then manager:=o.created_by_user_id;end if;
 if new.policy_revision is distinct from r or new.advisor_user_id is distinct from manager or not app_private.muerdeme_order_has_burger_v1(new.order_id)then
  raise exception 'Las condiciones del estímulo no coinciden con la orden.'using errcode='22023';end if;
 new.captured_at:=now();return new;
end;
$f$;
create trigger muerdeme_incentive_terms_guard before insert on app_private.muerdeme_order_incentive_terms
 for each row execute function app_private.muerdeme_incentive_terms_guard_v1();
create function app_private.muerdeme_incentive_capture_v1()returns trigger language plpgsql security invoker set search_path=''as $f$
declare r integer;manager uuid;
begin
 if position('@muerdeme|'in coalesce(new.notes,''))=0 then return new;end if;
 if not app_private.muerdeme_order_has_burger_v1(new.order_id)or exists(select 1 from app_private.muerdeme_order_incentive_terms where order_id=new.order_id)then return new;end if;
 perform pg_advisory_xact_lock(hashtextextended('commercial-incentive-draft:muerdeme',0));
 select max(revision)into r from app_private.commercial_incentive_policy_revisions where brand_code='muerdeme';
 select o.created_by_user_id into manager from public.orders o where o.id=new.order_id and o.source::text='advisor'
  and exists(select 1 from public.user_roles u where u.user_id=o.created_by_user_id and u.role::text='advisor');
 insert into app_private.muerdeme_order_incentive_terms(order_id,policy_revision,advisor_user_id)values(new.order_id,r,manager)on conflict(order_id)do nothing;
 return new;
end;
$f$;
create trigger zzzz_muerdeme_incentive_capture after insert or update on public.order_items
 for each row execute function app_private.muerdeme_incentive_capture_v1();

create table app_private.muerdeme_incentive_settlement_links(
 order_id bigint primary key references app_private.muerdeme_order_incentive_terms(order_id),
 closure_id bigint not null references public.advisor_commission_closures(id)deferrable initially deferred,
 receipt jsonb not null,created_at timestamptz not null default now()
);
create index muerdeme_incentive_closure_idx on app_private.muerdeme_incentive_settlement_links(closure_id);
alter table app_private.muerdeme_incentive_settlement_links enable row level security;
revoke all on app_private.muerdeme_incentive_settlement_links from public,anon,authenticated,service_role;
grant select,insert,delete on app_private.muerdeme_incentive_settlement_links to authenticated;
create policy muerdeme_incentive_links_read on app_private.muerdeme_incentive_settlement_links for select to authenticated
 using((select app_private.muerdeme_order_reader_v1())and((select app_private.muerdeme_incentive_admin_v1())or exists(select 1 from public.advisor_commission_closures c
  where c.id=closure_id and c.advisor_user_id=(select auth.uid()))));
create policy muerdeme_incentive_links_insert on app_private.muerdeme_incentive_settlement_links for insert to authenticated
 with check((select app_private.muerdeme_incentive_admin_v1()));
create policy muerdeme_incentive_links_delete on app_private.muerdeme_incentive_settlement_links for delete to authenticated
 using((select app_private.muerdeme_incentive_admin_v1()));
create function app_private.muerdeme_incentive_delivery_date_v1(p_extra jsonb,p_created timestamptz)returns date language sql stable security invoker set search_path=''as $f$
 select coalesce((nullif(p_extra#>>'{delivery,completed_at}','')::timestamptz at time zone'America/Caracas')::date,
  nullif(p_extra#>>'{schedule,date}','')::date,(p_created at time zone'America/Caracas')::date);
$f$;
create function app_private.muerdeme_incentive_state_v1(p_order bigint)returns jsonb language plpgsql stable security invoker set search_path=''as $f$
declare o record;terms record;first_id bigint;f jsonb;status text;kind text;amount numeric;
begin
 select * into o from public.orders where id=p_order;
 select t.*,p.first_order_usd,p.recurrent_order_usd into terms from app_private.muerdeme_order_incentive_terms t
  join app_private.commercial_incentive_policy_revisions p on p.brand_code=t.brand_code and p.revision=t.policy_revision where t.order_id=p_order;
 if not found then return null;end if;
 select l.order_id into first_id from app_private.muerdeme_incentive_settlement_links l join public.advisor_commission_closures c on c.id=l.closure_id
  join public.orders prior on prior.id=l.order_id where prior.client_id=o.client_id and c.status in('closed','paid')and l.receipt->>'purchaseKind'='first'
  order by prior.created_at,prior.id limit 1;
 if first_id is null then
  select prior.id into first_id from public.orders prior join app_private.muerdeme_order_incentive_terms t on t.order_id=prior.id
  cross join lateral public.get_order_financial_state(prior.id,null,null)f
  where prior.client_id=o.client_id and prior.status::text='delivered'and app_private.muerdeme_order_has_burger_v1(prior.id)
   and f.total_usd>0 and f.confirmed_paid_usd>0 and f.pending_usd<0.01
  order by app_private.muerdeme_incentive_delivery_date_v1(prior.extra_fields,prior.created_at),prior.created_at,prior.id limit 1;
 end if;
 kind:=case when first_id=o.id then'first'else'recurrent'end;
 amount:=case when kind='first'then terms.first_order_usd else terms.recurrent_order_usd end;
 status:=case when o.status::text='cancelled'then'cancelled'when not app_private.muerdeme_order_has_burger_v1(o.id)then'no_burger'
  when terms.advisor_user_id is null or o.source::text<>'advisor'then'direct'
  when not exists(select 1 from public.profiles p
    join public.user_roles u on u.user_id=p.id and u.role::text='advisor'where p.id=terms.advisor_user_id and p.is_active and p.receives_commissions)then'ineligible'
  when o.status::text<>'delivered'then'not_delivered'else'ready'end;
 if status='ready'then
  select to_jsonb(s)into f from public.get_order_financial_state(o.id,null,null)s;
  if f is null or coalesce((f->>'total_usd')::numeric,0)<=0 or coalesce((f->>'confirmed_paid_usd')::numeric,0)<=0
    or coalesce((f->>'pending_usd')::numeric,1)>=0.01 then status:='unpaid';end if;
 end if;
 return jsonb_build_object('orderId',o.id,'orderNumber',o.order_number,'advisorId',terms.advisor_user_id,'policyRevision',terms.policy_revision,
  'purchaseKind',kind,'amountUsd',amount,'status',status,'deliveryDate',app_private.muerdeme_incentive_delivery_date_v1(o.extra_fields,o.created_at));
end;
$f$;
create function public.admin_muerdeme_incentive_candidates_v1(p_period_id bigint,p_advisor_ids uuid[])returns jsonb language plpgsql stable security invoker set search_path=''as $f$
declare period record;result jsonb:='[]';row record;s jsonb;n integer:=0;
begin
 if app_private.muerdeme_incentive_admin_v1()is not true then raise exception 'Requiere administración o Máster activos.'using errcode='42501';end if;
 if cardinality(p_advisor_ids)is null or cardinality(p_advisor_ids)>200 then raise exception 'Revisa los asesores seleccionados.'using errcode='22023';end if;
 select * into period from public.advisor_commission_periods where id=p_period_id;
 if not found or period.status<>'open'then raise exception 'El período no está abierto.'using errcode='22023';end if;
 for row in select t.order_id from app_private.muerdeme_order_incentive_terms t join public.orders o on o.id=t.order_id
  left join app_private.muerdeme_incentive_settlement_links l on l.order_id=t.order_id
  left join public.advisor_commission_closures c on c.id=l.closure_id
  where t.advisor_user_id=any(p_advisor_ids)and o.status::text='delivered'
   and app_private.muerdeme_incentive_delivery_date_v1(o.extra_fields,o.created_at)<=period.date_to
   and(l.order_id is null or c.period_id=p_period_id)order by t.order_id limit 501 loop
  n:=n+1;if n>500 then raise exception 'Hay más de 500 estímulos sin liquidar. Revisa períodos anteriores antes de continuar.'using errcode='22023';end if;
  s:=app_private.muerdeme_incentive_state_v1(row.order_id);
  if s->>'status'='ready'then result:=result||jsonb_build_array(s);end if;
 end loop;
 return jsonb_build_object('version',1,'rows',result);
end;
$f$;

create function app_private.muerdeme_incentive_link_guard_v1()returns trigger language plpgsql security invoker set search_path=''as $f$
begin
 if pg_trigger_depth()<2 then raise exception 'Relaciona los estímulos desde el cálculo de comisiones.'using errcode='42501';end if;
 if tg_op='DELETE'then
  if exists(select 1 from public.advisor_commission_closures c where c.id=old.closure_id and c.status<>'preliminary')then raise exception 'La relación ya está protegida.'using errcode='22023';end if;return old;
 end if;
 if new.receipt is distinct from app_private.muerdeme_incentive_state_v1(new.order_id)or new.receipt->>'status'<>'ready'then raise exception 'El estímulo cambió. Vuelve a calcular.'using errcode='40001';end if;
 if not exists(select 1 from public.advisor_commission_closures c where c.id=new.closure_id
  and c.advisor_user_id::text=new.receipt->>'advisorId'and(c.snapshot#>'{muerdeme_incentives,rows}')@>jsonb_build_array(new.receipt))then
  raise exception 'El estímulo no pertenece al desglose de esta liquidación.'using errcode='22023';end if;
 return new;
end;
$f$;
create trigger muerdeme_incentive_link_guard before insert or delete on app_private.muerdeme_incentive_settlement_links
 for each row execute function app_private.muerdeme_incentive_link_guard_v1();
create function app_private.muerdeme_incentive_closure_guard_v1()returns trigger language plpgsql security invoker set search_path=''as $f$
declare payload jsonb;item jsonb;s jsonb;total numeric:=0;period record;
begin
 if not coalesce(new.snapshot?'muerdeme_incentives',false)and(tg_op='INSERT'or not coalesce(old.snapshot?'muerdeme_incentives',false))then return new;end if;
 if app_private.muerdeme_incentive_admin_v1()is not true then raise exception 'Requiere administración o Máster activos.'using errcode='42501';end if;
 payload:=new.snapshot->'muerdeme_incentives';
 if tg_op='UPDATE'and old.status in('closed','paid')then
  if new.period_id is distinct from old.period_id or new.advisor_user_id is distinct from old.advisor_user_id then raise exception 'La liquidación protegida no puede cambiar de período ni asesor.'using errcode='22023';end if;
  if payload is distinct from old.snapshot->'muerdeme_incentives'then raise exception 'Reabre el cierre antes de cambiar sus estímulos.'using errcode='22023';end if;
  if old.status='paid'or new.status='preliminary'then return new;end if;
 end if;
 if payload is null then payload:='{"version":1,"totalUsd":0,"rows":[]}'::jsonb;end if;
 if payload->'version'is distinct from'1'::jsonb or jsonb_typeof(payload->'rows')is distinct from'array'or jsonb_array_length(payload->'rows')>500 then raise exception 'El desglose de estímulos está incompleto.'using errcode='22023';end if;
 select * into period from public.advisor_commission_periods where id=new.period_id;
 if tg_op='INSERT'or new.status='preliminary'then
  delete from app_private.muerdeme_incentive_settlement_links where closure_id=new.id;
 end if;
 for item in select a from jsonb_array_elements(payload->'rows')a order by(a->>'orderId')::bigint loop
  s:=app_private.muerdeme_incentive_state_v1((item->>'orderId')::bigint);
  if s is null or s is distinct from item or s->>'status'<>'ready'or s->>'advisorId'<>new.advisor_user_id::text
   or(s->>'deliveryDate')::date>period.date_to then raise exception 'Un estímulo ya no corresponde a este cierre. Vuelve a calcular antes de confirmar.'using errcode='40001';end if;
  total:=total+(s->>'amountUsd')::numeric;
  if tg_op='INSERT'or new.status='preliminary'then
   insert into app_private.muerdeme_incentive_settlement_links(order_id,closure_id,receipt)values((s->>'orderId')::bigint,new.id,s);
  elsif not exists(select 1 from app_private.muerdeme_incentive_settlement_links l where l.closure_id=new.id and l.order_id=(s->>'orderId')::bigint and l.receipt=s)then
   raise exception 'Vuelve a calcular el preliminar para relacionar sus estímulos.'using errcode='40001';
  end if;
 end loop;
 if total is distinct from(payload->>'totalUsd')::numeric then raise exception 'El total de estímulos no coincide.'using errcode='22023';end if;
 return new;
end;
$f$;
create trigger zzzz_muerdeme_incentive_closure_guard after insert or update on public.advisor_commission_closures
 for each row execute function app_private.muerdeme_incentive_closure_guard_v1();

-- Every partial or full payment checks the certified Muérdeme part under the existing order locks.
create function app_private.muerdeme_assert_commission_incentives_v1(p_closure_id bigint)returns void language plpgsql security invoker set search_path=''as $f$
declare c record;item jsonb;
begin
 if app_private.muerdeme_incentive_admin_v1()is not true then raise exception 'Requiere administración o Máster activos.'using errcode='42501';end if;
 select snapshot,status into c from public.advisor_commission_closures where id=p_closure_id;
 if c.status='paid'or not coalesce(c.snapshot?'muerdeme_incentives',false)then return;end if;
 for item in select a from jsonb_array_elements(c.snapshot#>'{muerdeme_incentives,rows}')a loop
  if item is distinct from app_private.muerdeme_incentive_state_v1((item->>'orderId')::bigint)then
   raise exception 'Pedido #%: cambió su entrega o cobranza. Reabre y recalcula la liquidación antes de pagar el estímulo.',item->>'orderNumber'using errcode='40001';
  end if;
 end loop;
end;
$f$;
do $install$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('app_private.record_commission_payment_v1(uuid,bigint,bigint,numeric,numeric,numeric,date,text)'::regprocedure);
 anchor:='perform 1 from public.orders where id in (select jsonb_array_elements_text(app_private.commission_collection_state_v1(p_closure_id)->''orderIds'')::bigint) order by id for update;';
 if position(anchor in definition)=0 then raise exception 'Cambió el circuito de pago de comisiones. Revisa antes de integrar.';end if;
 execute replace(definition,anchor,E'perform 1 from public.orders where id in (select jsonb_array_elements_text(app_private.commission_collection_state_v1(p_closure_id)->''orderIds'')::bigint union select (m->>''orderId'')::bigint from jsonb_array_elements(coalesce(v_closure.snapshot#>''{muerdeme_incentives,rows}'',''[]''::jsonb))m) order by id for update;\n  if v_closure.snapshot?''muerdeme_incentives''then perform app_private.muerdeme_assert_commission_incentives_v1(p_closure_id);end if;');
end;
$install$;

-- Future policies remain configurable after opening; each order keeps its captured revision.
do $install$
declare definition text;anchor text;
begin
 definition:=pg_get_functiondef('public.admin_commercial_incentive_draft_save_v1(numeric,numeric,integer,uuid)'::regprocedure);
 anchor:=E'  if not exists (select 1 from app_private.commercial_brands\n    where code = ''muerdeme'' and not sales_enabled) then\n    raise exception ''La marca ya está habilitada; utiliza su configuración comercial vigente.'';\n  end if;';
 if position(anchor in definition)=0 then raise exception 'Cambió el guardado de importes. Revisa antes de integrar.';end if;
 execute replace(definition,anchor,'');
end;
$install$;
revoke all on function app_private.muerdeme_incentive_admin_v1(),app_private.muerdeme_order_has_burger_v1(bigint),
 app_private.muerdeme_incentive_terms_guard_v1(),app_private.muerdeme_incentive_capture_v1(),app_private.muerdeme_incentive_delivery_date_v1(jsonb,timestamptz),
 app_private.muerdeme_incentive_state_v1(bigint),app_private.muerdeme_incentive_link_guard_v1(),app_private.muerdeme_incentive_closure_guard_v1(),
 app_private.muerdeme_assert_commission_incentives_v1(bigint),
 public.admin_muerdeme_incentive_candidates_v1(bigint,uuid[])from public,anon,authenticated,service_role;
grant execute on function app_private.muerdeme_incentive_admin_v1(),app_private.muerdeme_order_has_burger_v1(bigint),
 app_private.muerdeme_incentive_delivery_date_v1(jsonb,timestamptz),app_private.muerdeme_incentive_state_v1(bigint),
 public.admin_muerdeme_incentive_candidates_v1(bigint,uuid[])to authenticated;
commit;
