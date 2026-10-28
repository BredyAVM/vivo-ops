-- Block 1 is additive: no legacy product, client, order or financial writer changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table app_private.commercial_brands (
  code text primary key check (code in ('vivo', 'muerdeme')),
  name text not null,
  sales_enabled boolean not null default false,
  created_at timestamptz not null default now()
);
insert into app_private.commercial_brands(code, name, sales_enabled)
values ('vivo', 'VIVO Fritos', true), ('muerdeme', 'Muérdeme', false);

-- Missing assignments mean legacy VIVO. No backfill or change to product rows.
create table app_private.commercial_product_brands (
  product_id bigint primary key references public.products(id) on delete cascade,
  brand_code text not null references app_private.commercial_brands(code),
  created_at timestamptz not null default now()
);
create index commercial_product_brands_brand_idx
  on app_private.commercial_product_brands(brand_code, product_id);

-- Acquisition is separate from clients.primary_advisor_id and client_type.
-- Writes are intentionally unavailable until the canonical intake command exists.
create table app_private.commercial_client_relationships (
  client_id bigint not null references public.clients(id) on delete cascade,
  brand_code text not null references app_private.commercial_brands(code),
  acquisition_channel text not null check (
    acquisition_channel in ('advisor', 'direct_phone', 'instagram', 'other')
  ),
  referred_by_user_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (client_id, brand_code)
);
create index commercial_client_relationships_brand_idx
  on app_private.commercial_client_relationships(brand_code, client_id);

-- Append-only preparation settings, not accrued or payable commissions.
create table app_private.commercial_incentive_policy_revisions (
  brand_code text not null references app_private.commercial_brands(code)
    check (brand_code = 'muerdeme'),
  revision integer not null check (revision > 0),
  first_order_usd numeric(12,2) not null check (
    first_order_usd >= 0 and first_order_usd < 1000000000
  ),
  recurrent_order_usd numeric(12,2) not null check (
    recurrent_order_usd >= 0 and recurrent_order_usd < 1000000000
  ),
  requires_burger boolean not null default true check (requires_burger),
  status text not null default 'draft' check (status = 'draft'),
  operation_id uuid unique,
  actor_id uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (brand_code, revision)
);
insert into app_private.commercial_incentive_policy_revisions
  (brand_code, revision, first_order_usd, recurrent_order_usd)
values ('muerdeme', 1, 0.30, 0.20);

create function app_private.commercial_foundation_is_admin_v1()
returns boolean language sql stable security invoker set search_path = '' as $f$
  select (select auth.uid()) is not null
    and public.has_role('admin') is true
    and exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid()) and p.is_active
    );
$f$;
revoke all on function app_private.commercial_foundation_is_admin_v1()
  from public, anon, authenticated, service_role;
grant usage on schema app_private to authenticated;
grant execute on function app_private.commercial_foundation_is_admin_v1() to authenticated;

alter table app_private.commercial_brands enable row level security;
alter table app_private.commercial_product_brands enable row level security;
alter table app_private.commercial_client_relationships enable row level security;
alter table app_private.commercial_incentive_policy_revisions enable row level security;
revoke all on app_private.commercial_brands,
  app_private.commercial_product_brands,
  app_private.commercial_client_relationships,
  app_private.commercial_incentive_policy_revisions
  from public, anon, authenticated, service_role;
grant select on app_private.commercial_brands,
  app_private.commercial_product_brands,
  app_private.commercial_client_relationships,
  app_private.commercial_incentive_policy_revisions to authenticated;
grant insert on app_private.commercial_incentive_policy_revisions to authenticated;

create policy commercial_brands_admin_read on app_private.commercial_brands
  for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy commercial_product_brands_admin_read on app_private.commercial_product_brands
  for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy commercial_client_relationships_admin_read on app_private.commercial_client_relationships
  for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy commercial_incentive_policy_admin_read on app_private.commercial_incentive_policy_revisions
  for select to authenticated
  using ((select app_private.commercial_foundation_is_admin_v1()));
create policy commercial_incentive_policy_admin_insert on app_private.commercial_incentive_policy_revisions
  for insert to authenticated with check (
    (select app_private.commercial_foundation_is_admin_v1())
    and actor_id = (select auth.uid()) and operation_id is not null
  );

create function public.admin_commercial_foundation_read_v1(
  p_include_catalog boolean default false,
  p_brand_code text default null,
  p_query text default '',
  p_page integer default 1
) returns jsonb language plpgsql stable security invoker set search_path = '' as $f$
declare
  v_brands jsonb; v_products jsonb := '[]'::jsonb;
  v_has_next boolean := false;
begin
  if app_private.commercial_foundation_is_admin_v1() is not true then
    raise exception 'Esta operación requiere un administrador activo.' using errcode = '42501';
  end if;
  if p_include_catalog is null or p_page is null or p_page < 1 or p_page > 10000
    or (p_brand_code is not null and p_brand_code not in ('vivo', 'muerdeme'))
    or p_query is null or length(p_query) > 100 then
    raise exception 'Filtros de marcas inválidos.' using errcode = '22023';
  end if;
  select jsonb_agg(jsonb_build_object(
    'code', b.code, 'name', b.name, 'salesEnabled', b.sales_enabled,
    'incentivePolicy', (
      select jsonb_build_object('revision', r.revision,
        'firstOrderUsd', r.first_order_usd, 'recurrentOrderUsd', r.recurrent_order_usd,
        'requiresBurger', r.requires_burger, 'status', r.status, 'createdAt', r.created_at)
      from app_private.commercial_incentive_policy_revisions r
      where r.brand_code = b.code order by r.revision desc limit 1
    )
  ) order by b.code desc) into v_brands
  from app_private.commercial_brands b;
  if p_include_catalog then
    with page_rows as (
      select p.id, p.name, p.is_active, p.source_price_amount,
        p.source_price_currency, coalesce(a.brand_code, 'vivo') as brand_code
      from public.products p
      left join app_private.commercial_product_brands a on a.product_id = p.id
      where (p_brand_code is null or coalesce(a.brand_code, 'vivo') = p_brand_code)
        and (btrim(p_query) = '' or position(lower(btrim(p_query)) in lower(p.name)) > 0)
      order by p.name, p.id limit 26 offset (p_page - 1) * 25
    ), numbered as (
      select *, row_number() over (order by name, id) as local_row from page_rows
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'name', name, 'isActive', is_active, 'brandCode', brand_code,
      'amount', source_price_amount, 'currency', source_price_currency
    ) order by name, id) filter (where local_row <= 25), '[]'::jsonb),
      coalesce(bool_or(local_row = 26), false)
    into v_products, v_has_next from numbered;
  end if;
  return jsonb_build_object('version', 'commercial-foundation-v1', 'brands', v_brands,
    'catalog', v_products, 'hasNext', v_has_next, 'page', p_page);
end;
$f$;

create function public.admin_commercial_incentive_draft_save_v1(
  p_first_order_usd numeric, p_recurrent_order_usd numeric,
  p_expected_revision integer, p_operation_id uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $f$
declare
  v_actor uuid := (select auth.uid());
  v_current app_private.commercial_incentive_policy_revisions%rowtype;
  v_saved app_private.commercial_incentive_policy_revisions%rowtype;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'Reintenta el guardado en una nueva consulta.' using errcode = '25001';
  end if;
  if app_private.commercial_foundation_is_admin_v1() is not true then
    raise exception 'Esta operación requiere un administrador activo.' using errcode = '42501';
  end if;
  if p_operation_id is null or p_expected_revision is null or p_expected_revision < 1
    or p_first_order_usd is null or p_recurrent_order_usd is null
    or p_first_order_usd::text in ('NaN', 'Infinity', '-Infinity')
    or p_recurrent_order_usd::text in ('NaN', 'Infinity', '-Infinity')
    or p_first_order_usd < 0 or p_first_order_usd >= 1000000000
    or p_recurrent_order_usd < 0 or p_recurrent_order_usd >= 1000000000
    or p_first_order_usd <> round(p_first_order_usd, 2)
    or p_recurrent_order_usd <> round(p_recurrent_order_usd, 2) then
    raise exception 'Introduce importes en USD válidos con hasta dos decimales.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('commercial-incentive-draft:muerdeme', 0));
  if app_private.commercial_foundation_is_admin_v1() is not true then
    raise exception 'Esta operación requiere un administrador activo.' using errcode = '42501';
  end if;
  select * into v_saved from app_private.commercial_incentive_policy_revisions
    where operation_id = p_operation_id;
  if found then
    if v_saved.actor_id is distinct from v_actor
      or v_saved.first_order_usd <> p_first_order_usd
      or v_saved.recurrent_order_usd <> p_recurrent_order_usd
      or v_saved.revision <> p_expected_revision + 1 then
      raise exception 'La solicitud ya fue utilizada con otros datos.' using errcode = '22023';
    end if;
    return jsonb_build_object('revision', v_saved.revision, 'status', v_saved.status);
  end if;
  if not exists (select 1 from app_private.commercial_brands
    where code = 'muerdeme' and not sales_enabled) then
    raise exception 'La marca ya está habilitada; utiliza su configuración comercial vigente.';
  end if;
  select * into strict v_current from app_private.commercial_incentive_policy_revisions
    where brand_code = 'muerdeme' order by revision desc limit 1;
  if v_current.revision <> p_expected_revision then
    raise exception 'La configuración cambió. Vuelve a consultar antes de guardar.' using errcode = '40001';
  end if;
  insert into app_private.commercial_incentive_policy_revisions
    (brand_code, revision, first_order_usd, recurrent_order_usd, operation_id, actor_id)
  values ('muerdeme', v_current.revision + 1,
    p_first_order_usd, p_recurrent_order_usd, p_operation_id, v_actor)
  returning * into v_saved;
  return jsonb_build_object('revision', v_saved.revision, 'status', v_saved.status);
end;
$f$;

revoke all on function public.admin_commercial_foundation_read_v1(boolean,text,text,integer),
  public.admin_commercial_incentive_draft_save_v1(numeric,numeric,integer,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_commercial_foundation_read_v1(boolean,text,text,integer),
  public.admin_commercial_incentive_draft_save_v1(numeric,numeric,integer,uuid) to authenticated;
comment on table app_private.commercial_incentive_policy_revisions is
  'Muérdeme preparation settings only. No accrued incentive or commission settlement reads this table in block 1.';
comment on table app_private.commercial_client_relationships is
  'Independent brand acquisition metadata. Does not change client ownership or authorize access to the underlying client.';
commit;
