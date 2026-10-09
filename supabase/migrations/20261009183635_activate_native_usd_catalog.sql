-- Authorized catalog activation. Current money, saved drafts, orders and CRM
-- reservations are not updated. Fail atomically if any approved price is stale.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
select pg_catalog.pg_advisory_xact_lock(20261009,1);
lock table public.products in share row exclusive mode;

create temporary table catalog_usd_proposal_v1(sku text primary key,previous_currency text,previous_amount numeric,next_usd numeric) on commit drop;
insert into catalog_usd_proposal_v1 values
('MM_2OZ','VES',1150,1.5),
('MM_5OZ','VES',2300,3),
('BOMB_C_25','VES',11500,14),
('BOMB_F_25','VES',11500,14),
('BOMB_PF_25','VES',11500,14),
('CACH_C_20','VES',11500,14),
('CACH_F_20','VES',11500,14),
('CACH_PF_20','VES',11500,14),
('CHIN_1500','VES',2300,2.5),
('CHIN_2000','VES',2875,3.5),
('COKE_1000','VES',1725,2),
('COKE_1500','VES',2300,2.5),
('COKE_1500MAYOR','USD',6.72,6.72),
('COKE_2000','VES',2875,3.5),
('COKE_LAT','VES',1150,1.5),
('COKE_ZERO_1000','VES',1725,2),
('COKE_ZERO_2000','VES',2300,2.5),
('BABYMIX_F_25','VES',12650,15),
('BABYMIX_F_25A','VES',12650,15),
('RUMBAMIX_F_76','VES',34500,40),
('RUMBAMIX_F_76A','VES',34500,40),
('SEXYMIX_F_50','VES',23000,28),
('SEXYMIX_F_50A','VES',23000,28),
('DEL_Z1','VES',2300,2.5),
('DEL_Z2','VES',3450,4),
('DEL_Z3','VES',4600,5),
('DEL_Z4','VES',5750,6.5),
('DEL_Z5','VES',6900,8),
('DEL_Z6','VES',8050,9.5),
('DEL_Z7','VES',9200,10.5),
('DONDY_1','VES',1150,1.5),
('DONDY_6','VES',6900,8),
('EMP_C_20','VES',11500,14),
('EMP_F_20','VES',11500,14),
('EMP_PF_20','VES',11500,14),
('FANTA_15LT','VES',2300,2.5),
('FRESC_1500','VES',2300,2.5),
('FRESC_2000','VES',2875,3.5),
('JDV_1500','VES',2300,2.5),
('LIP_DUR_1500','VES',5175,6),
('LIP_LIM_1500','VES',5175,6),
('MALTA_LAT','VES',1150,1.5),
('MAND_C_25','VES',11500,14),
('MAND_F_25','VES',11500,14),
('MAND_PF_25','VES',11500,14),
('MINI_TEQ_C_25','VES',11500,14),
('MINI_TEQ_F_25','VES',11500,14),
('MINI_TEQ_PF_25','VES',11500,14),
('MIX_BOMB_MAND_F_24','VES',11500,14),
('MIX_CACH_BOMB_F_22','VES',11500,14),
('MIX_CACH_EMP_F_20','VES',11500,14),
('MIX_CACH_MAND_F_22','VES',11500,14),
('MIX_EMP_BOMB_F_22','VES',11500,14),
('MIX_EMP_MAND_F_22','VES',11500,14),
('MIX_MTEQ_BOMB_F_24','VES',11500,14),
('MIX_MTEQ_CACH_F_22','VES',11500,14),
('MIX_MTEQ_EMP_F_22','VES',11500,14),
('MIX_MTEQ_MAND_F_24','VES',11500,14),
('PEPSI_1000','VES',1725,2),
('PEPSI_1500','VES',2300,2.5),
('PEPSI_2000','VES',2875,3.5),
('PEPSI_LAT','VES',1150,1.5),
('SAL_TAR_1OZ','VES',575,1),
('SAL_TAR_2OZ','VES',1150,1.5),
('SAL_TAR_5OZ','VES',2300,3),
('SAL_TAR_GALON','USD',35,35),
('SINGLE_10','VES',5750,6.5),
('SINGLE_6','VES',3450,4),
('SINGLE_8','VES',4600,5.5),
('TEQREG_C_5','VES',4025,5),
('TEQREG_F_5','VES',4025,5),
('TEQREG_PF_5','VES',4025,5),
('VIVOBOX_6','VES',6900,8),
('VIVOBOX_XL_8','VES',8050,9.5),
('VIVOBOX_XXL_10','VES',9200,10.5),
('YUK_MAN_1500','VES',5175,6),
('YUK_NAR_1500','VES',5175,6),
('YUK_PER_1500','VES',5175,6),
('YUKYPACK','VES',1150,1.5);

create table app_private.usd_catalog_activation_audit_v1 (
  product_id bigint primary key references public.products(id),
  sku text not null,
  previous_price jsonb not null,
  activated_price jsonb,
  activated_at timestamptz not null default statement_timestamp()
);
alter table app_private.usd_catalog_activation_audit_v1 enable row level security;
revoke all on app_private.usd_catalog_activation_audit_v1 from public,anon,authenticated,service_role;

do $guard$
begin
  if not exists(select 1 from app_private.usd_catalog_cutover_v1 where activated_at is null) then
    raise exception 'USD catalog is already activated'; end if;
  if (select count(*) from catalog_usd_proposal_v1)<>79 or exists(
    select 1 from catalog_usd_proposal_v1 proposed left join public.products p on p.sku=proposed.sku
    where p.id is null or not p.is_active or p.source_price_currency::text<>proposed.previous_currency
      or p.source_price_amount is distinct from proposed.previous_amount) then
    raise exception 'An approved catalog price changed; review before activation'; end if;
  if exists(select 1 from public.products p where p.is_active and p.source_price_amount>0
    and not exists(select 1 from catalog_usd_proposal_v1 s where s.sku=p.sku)
    and p.sku not in ('ANIVERSARIO_10','ANIVERSARIO_8_SP','LC_SINGLE_10','LC_SINGLE_8','LOYAL_SINGLE_10','LOYAL_SINGLE_8')) then
    raise exception 'An active paid product is missing from the approved catalog'; end if;
  if (select count(*) from public.products where is_active and type::text='gambit' and source_price_amount>0)<>6
    or exists(select 1 from public.products where is_active and sku in ('ANIVERSARIO_10','LC_SINGLE_10','LOYAL_SINGLE_10')
      and (source_price_currency::text<>'VES' or source_price_amount<>2300))
    or exists(select 1 from public.products where is_active and sku in ('ANIVERSARIO_8_SP','LC_SINGLE_8','LOYAL_SINGLE_8')
      and (source_price_currency::text<>'VES' or source_price_amount<>1150)) then
    raise exception 'A paid gift changed; review its approved difference'; end if;
  if not exists(select 1 from public.exchange_rates where is_active and rate_bs_per_usd>0
    and rate_bs_per_usd::text not in ('NaN','Infinity','-Infinity')) then
    raise exception 'A valid active exchange rate is required'; end if;
end;
$guard$;

insert into app_private.usd_catalog_activation_audit_v1(product_id,sku,previous_price)
select id,sku,jsonb_build_object('currency',source_price_currency,'amount',source_price_amount,
  'usd',base_price_usd,'bs',base_price_bs) from public.products where is_active;

update public.products p set source_price_currency='USD',source_price_amount=proposed.next_usd
from catalog_usd_proposal_v1 proposed where p.sku=proposed.sku;
update public.products set source_price_currency='USD' where is_active and source_price_amount=0
  and source_price_currency::text<>'USD';
-- Mark the same transaction as the cutover before synchronizing paid gifts.
update app_private.usd_catalog_cutover_v1 set activated_at=statement_timestamp() where singleton;
select app_private.sync_single_upgrade_products_v1();

do $verify$
begin
  if exists(select 1 from public.products where is_active and source_price_currency::text<>'USD') then
    raise exception 'Active catalog is not entirely native USD'; end if;
  if exists(select 1 from catalog_usd_proposal_v1 s join public.products p on p.sku=s.sku
    where p.source_price_amount is distinct from s.next_usd) then
    raise exception 'Activated price mismatch'; end if;
  if exists(select 1 from app_private.usd_catalog_activation_audit_v1 a join public.products p on p.id=a.product_id
    where (a.previous_price->>'amount')::numeric=0 and p.source_price_amount<>0) then
    raise exception 'A free product lost its zero price'; end if;
end;
$verify$;

update app_private.usd_catalog_activation_audit_v1 a set activated_price=jsonb_build_object(
  'currency',p.source_price_currency,'amount',p.source_price_amount,'usd',p.base_price_usd,'bs',p.base_price_bs)
from public.products p where p.id=a.product_id;
commit;
