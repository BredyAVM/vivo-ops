-- Authorized correction: October LC advisor contribution is USD 0.75, not 1.50.
-- A one-off maintenance repair, not a general permission to edit frozen costs.
-- Applied version recorded by the managed migration service (CLI scaffold aligned).
set local lock_timeout = '5s';
set local statement_timeout = '20s';

create table app_private.crm_play_cost_corrections (
  id bigint generated always as identity primary key,
  play_id bigint not null references public.crm_plays(id),
  benefit_id bigint not null references public.crm_play_benefits(id),
  previous_values jsonb not null,
  corrected_values jsonb not null,
  reason text not null,
  performed_by text not null default current_user,
  recorded_at timestamptz not null default now()
);
alter table app_private.crm_play_cost_corrections enable row level security;
revoke all on app_private.crm_play_cost_corrections from public, anon, authenticated, service_role;
create trigger crm_play_cost_corrections_immutable before update or delete
  on app_private.crm_play_cost_corrections for each row
  execute function app_private.crm_play_amendment_immutable_v1();

do $repair$
declare
  target public.crm_play_benefits%rowtype;
  original_benefit jsonb;
  original_uses jsonb;
  corrected_uses jsonb;
  original_closures jsonb;
  affected integer;
  expected_uses integer;
  guard_definitions jsonb;
begin
  -- Prevent concurrent reservation/delivery/commission closure while changing
  -- only these monetary snapshots. All trigger protections are restored before
  -- this transaction commits; on any error the entire repair rolls back.
  lock table public.advisor_commission_closures in share row exclusive mode;
  lock table public.crm_play_redemptions in access exclusive mode;
  lock table public.crm_play_benefits in access exclusive mode;
  select b.* into strict target
  from public.crm_play_benefits b join public.crm_plays p on p.id=b.play_id
  where p.name='LC · clientes perdidos · octubre de 2026'
    and p.status='active'
    and p.starts_at >= '2026-10-01T00:00:00-04:00'::timestamptz
    and p.starts_at < '2026-11-01T00:00:00-04:00'::timestamptz
    and b.product_name_snapshot='Single Pack (6 und)'
    and b.quantity=1 and b.unit_benefit_value_usd=4
    and b.unit_advisor_cost_usd=1.50 and b.unit_company_cost_usd=2.50
    and b.unit_budget_cost_usd=2.50;

  if exists(select 1 from public.crm_play_redemptions r
    where r.play_benefit_id=target.id and r.status in ('reserved','redeemed')
      and (r.quantity<>1 or r.unit_benefit_value_usd<>4 or r.benefit_value_usd<>4
        or r.unit_advisor_cost_usd<>1.50 or r.advisor_charge_usd<>1.50
        or r.unit_company_cost_usd<>2.50 or r.company_cost_usd<>2.50)) then
    raise exception 'LC usage economics differ from audited state; review before repair';
  end if;
  -- Do not silently rewrite an already agreed/paid commission period.
  if exists(select 1 from public.crm_play_redemptions r
    join public.orders o on o.id=r.order_id
    join public.advisor_commission_closures c on c.advisor_user_id=o.attributed_advisor_id
    join public.advisor_commission_periods period on period.id=c.period_id
    where r.play_benefit_id=target.id and r.status='redeemed'
      and c.status<>'preliminary'
      and (r.redeemed_at at time zone 'America/Caracas')::date between period.date_from and period.date_to) then
    raise exception 'An affected commission period is closed; a settlement adjustment is required';
  end if;
  if (select count(*) from pg_trigger where not tgisinternal and tgenabled='O'
    and ((tgrelid='public.crm_play_benefits'::regclass and tgname='crm_play_benefits_guard')
      or (tgrelid='public.crm_play_redemptions'::regclass and tgname='crm_play_redemptions_guard')))<>2 then
    raise exception 'CRM monetary immutability guards differ from audited state';
  end if;
  select jsonb_object_agg(p.oid::text,pg_get_functiondef(p.oid)) into guard_definitions
    from pg_proc p where p.oid in ('app_private.crm_play_benefit_guard_v2()'::regprocedure,
      'app_private.crm_play_redemption_guard_v1()'::regprocedure);
  original_benefit:=to_jsonb(target);
  select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb),count(*)::integer
    into original_uses,expected_uses from public.crm_play_redemptions r
    where r.play_benefit_id=target.id and r.status in ('reserved','redeemed');
  select coalesce(jsonb_agg(to_jsonb(c) order by c.id),'[]'::jsonb) into original_closures
    from public.advisor_commission_closures c where c.advisor_user_id in
      (select distinct o.attributed_advisor_id from public.crm_play_redemptions r
        join public.orders o on o.id=r.order_id where r.play_benefit_id=target.id);

  alter table public.crm_play_benefits disable trigger crm_play_benefits_guard;
  update public.crm_play_benefits set unit_advisor_cost_usd=0.75,
    unit_company_cost_usd=3.25,unit_budget_cost_usd=3.25 where id=target.id;
  alter table public.crm_play_benefits enable trigger crm_play_benefits_guard;
  alter table public.crm_play_redemptions disable trigger crm_play_redemptions_guard;
  update public.crm_play_redemptions set unit_advisor_cost_usd=0.75,
    advisor_charge_usd=0.75,unit_company_cost_usd=3.25,company_cost_usd=3.25
    where play_benefit_id=target.id and status in ('reserved','redeemed');
  get diagnostics affected = row_count;
  if affected<>expected_uses then raise exception 'LC usage count changed during repair'; end if;
  alter table public.crm_play_redemptions enable trigger crm_play_redemptions_guard;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]'::jsonb) into corrected_uses
    from public.crm_play_redemptions r where r.play_benefit_id=target.id and r.status in ('reserved','redeemed');
  if exists(select 1 from jsonb_array_elements(original_uses) old_row
    join jsonb_array_elements(corrected_uses) new_row on old_row->>'id'=new_row->>'id'
    where old_row-array['unit_advisor_cost_usd','advisor_charge_usd','unit_company_cost_usd','company_cost_usd']
      is distinct from new_row-array['unit_advisor_cost_usd','advisor_charge_usd','unit_company_cost_usd','company_cost_usd']) then
    raise exception 'Non-cost CRM evidence changed';
  end if;
  if (select jsonb_object_agg(p.oid::text,pg_get_functiondef(p.oid))
    from pg_proc p where p.oid in ('app_private.crm_play_benefit_guard_v2()'::regprocedure,
      'app_private.crm_play_redemption_guard_v1()'::regprocedure)) is distinct from guard_definitions then
    raise exception 'CRM monetary guards were modified';
  end if;

  insert into app_private.crm_play_cost_corrections(play_id,benefit_id,previous_values,corrected_values,reason)
  values(target.play_id,target.id,
    jsonb_build_object('benefit',original_benefit,'redemptions',original_uses,'commission_closures',original_closures),
    jsonb_build_object('benefit',(select to_jsonb(b) from public.crm_play_benefits b where b.id=target.id),
      'redemptions',corrected_uses,'commission_recalculation_required',true),
    'Solicitud expresa del usuario el 16/10/2026: corregir aporte del asesor de la última LC de $1.50 a $0.75. Valor del beneficio $4 intacto; empresa $3.25. Incluye reservas y entregas; las relaciones preliminares deben recalcularse por su flujo normal. Sin suplantar una sesión de administrador.');
  perform app_private.crm_refresh_published_play_summary_v1(target.play_id);
end;
$repair$;
