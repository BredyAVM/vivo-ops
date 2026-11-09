// Installed production guards in an isolated PostgreSQL runtime; never real orders.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const read = path => readFileSync(new URL('../../'+path, import.meta.url),'utf8');
function extract(source,name) {
  const start=source.toLowerCase().indexOf('create or replace function '+name+'(');
  assert.ok(start>=0,name);
  const opener=/as\s+(\$[a-z_]*\$)/i.exec(source.slice(start));
  const end=source.indexOf(opener[1],start+opener.index+opener[0].length);
  return source.slice(start,end+opener[1].length)+';';
}
test('shared coupon: canonical pricing, edit, reservation, delivery, cancellation, minimum and authority',async()=>{
  const db=new PGlite();
  try {
    const existing=read('tests/crm/catalog-gift-db.mjs');
    const start=existing.indexOf('await db.exec(`')+'await db.exec(`'.length;
    await db.exec(existing.slice(start,existing.indexOf('`);',start)));
    await db.exec(`
      alter table profiles add column full_name text;
      alter table products add column source_price_currency text default 'USD', add column inventory_group text default 'other';
      alter table orders add column fulfillment text default 'delivery', add column delivery_date date default current_date;
      alter table order_items add column reward_grant_id bigint, add column draft_price_agreement_key text,
        add column pricing_fx_rate_snapshot numeric,add column reward_amount_usd numeric;
      alter table crm_plays add column rules_snapshot jsonb default '{}', add column selection_summary jsonb default '{}',
        add column planned_budget_usd numeric, add column benefit_recurrence_mode text default 'once',
        add column snapshot_at timestamptz, add column pricing_exchange_rate_ves_per_usd numeric,add column pricing_snapshot_at timestamptz;
      alter table crm_play_members add column last_gift_on date, add column purchase_count bigint default 1, add column net_revenue_usd numeric default 20;
      alter table crm_play_benefits add column product_name_snapshot text,add column source_price_currency_snapshot text,
        add column source_price_amount_snapshot numeric,add column catalog_price_usd_snapshot numeric;
      alter table crm_play_benefit_upgrades add column target_product_name_snapshot text,add column target_source_price_currency_snapshot text,
        add column target_source_price_amount_snapshot numeric,add column target_catalog_price_usd_snapshot numeric;
      alter table crm_play_redemptions add column recurrence_mode_snapshot text default 'once',add column benefit_day date;
      alter table crm_play_benefits add constraint crm_play_benefits_sort_order_check check(sort_order between 1 and 8);
      create table app_private.crm_order_minimum_exceptions(order_id bigint,play_member_id bigint,benefit_fingerprint text,
        minimum_authorized_usd numeric,reason text,approved_at timestamptz,approved_by uuid);
      create function public.is_admin() returns boolean language sql as $$select auth.role()='admin'$$;
      create function app_private.order_uses_current_usd_v1(bigint) returns boolean language sql as $$select false$$;
      create function public.current_customer_difference_usd(public.crm_play_benefit_upgrades) returns numeric language sql as $$select $1.customer_difference_usd_snapshot$$;
      create function app_private.order_item_operational_quantity_v1(jsonb,jsonb) returns boolean language sql as $$select false$$;
      create function app_private.crm_order_has_validity_exception_v1(bigint,bigint) returns boolean language sql as $$select false$$;
      create function app_private.crm_order_benefit_day_v1(bigint) returns date language sql as $$select current_date$$;
      create function app_private.crm_paid_products_subtotal_v1(bigint) returns numeric language sql as $$
        select coalesce(sum(i.line_total_usd),0) from public.order_items i join public.products p on p.id=i.product_id
        where order_id=$1 and crm_play_member_id is null and p.inventory_group<>'delivery'$$;
      create function app_private.crm_play_has_overlap_conflict_v1(bigint,bigint) returns boolean language sql as $$select false$$;
      create function app_private.crm_had_excluded_offer_v1(bigint,timestamptz,jsonb) returns boolean language sql as $$select false$$;
      create function public.get_active_exchange_rate() returns numeric language sql as $$select 100$$;
    `);
    // SQL helpers must exist before dependent SQL functions are installed.
    await db.exec(read('tests/crm/fixtures/coupon-installed-functions.sql'));
    await db.exec(read('supabase/migrations/20261109185549_crm_shared_coupon_v1.sql'));
    await db.exec(read('supabase/migrations/20261109191708_crm_coupon_catalog_options_v1.sql'));
    const lifecycle=read('supabase/migrations/20260912001929_crm_benefit_reservation_delivery_lifecycle_v1.sql');
    await db.exec(extract(lifecycle,'app_private.crm_finalize_order_benefits_on_delivery_v1'));
    await db.exec(extract(lifecycle,'app_private.crm_void_play_redemptions_on_order_cancel_v1'));
    await db.exec(`
      create trigger a_crm_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1();
      create trigger b_pricing_guard before insert or update on order_items for each row when(new.crm_play_member_id is not null) execute function public.trg_order_items_pricing_guard();
      create trigger c_set_pricing before insert or update on order_items for each row when(new.crm_play_member_id is not null) execute function public.trg_order_items_set_pricing();
      create trigger reserve after insert on order_items for each row when(new.crm_play_member_id is not null) execute function app_private.crm_reserve_order_item_benefit_v1();
      create trigger release before delete on order_items for each row when(old.crm_play_member_id is not null) execute function app_private.crm_release_order_item_reservation_v1();
      create trigger redemption_guard before insert or update or delete on crm_play_redemptions for each row execute function app_private.crm_play_redemption_guard_v1();
      create trigger finalize after update of status on orders for each row execute function app_private.crm_finalize_order_benefits_on_delivery_v1();
      create trigger cancel after update of status on orders for each row execute function app_private.crm_void_play_redemptions_on_order_cancel_v1();
      insert into products(id,sku,name,type,source_price_amount,base_price_usd,inventory_group) values
        (10,'DRINK','Refresco 2L','product',3.5,3.5,'beverages'),(11,'ZONE2','Delivery Zona 2','product',4,4,'delivery'),
        (12,'ZONE7','Delivery Zona 7','product',10.5,10.5,'delivery'),(13,'FOOD','Combo','product',15,15,'food'),
        (14,'CHEAP','Malta','product',1.1,1.1,'beverages'),(15,'VES','Jugo','product',250,2.5,'beverages');
      update products set source_price_currency='VES' where id=15;
      insert into crm_plays(id,name,status,starts_at,ends_at,benefit_selection_mode,purchase_requirement_mode,minimum_order_amount_usd,rules_snapshot) values
        (2,'Cupón NC','active',now()-interval '1 day',now()+interval '1 month','multiple','minimum_order',15,
          '{"coupon_draft":{"maximum_discount_usd":4,"execution_support":"shared_cap_v1","economics":{"review_status":"approved","advisor_contribution_usd":0.75,"company_contribution_usd":3.25}}}');
      insert into crm_play_benefits(id,play_id,product_id,unit_advisor_cost_usd,unit_company_cost_usd) values(10,2,10,.75,3.25),(11,2,11,.75,3.25),(12,2,12,.75,3.25),(14,2,14,.75,3.25),(15,2,15,.75,3.25);
      insert into crm_play_members(id,play_id,client_id,advisor_id_snapshot) select n,2,n,auth.uid() from generate_series(10,20) n;
      insert into orders(id,order_number,client_id,attributed_advisor_id) select n,n::text,n,auth.uid() from generate_series(10,20) n;
      insert into orders(id,order_number,client_id,attributed_advisor_id) values(30,'30',10,auth.uid());
      insert into order_items(order_id,product_id,line_total_usd) select n,13,15 from generate_series(10,20) n;
    `);
    const rows=async sql=>(await db.query(sql)).rows;
    const scalar=async sql=>(await rows(sql))[0].v;
    const select=async(member,ids,order=null)=>db.query('select public.crm_prepare_coupon_selection_v1($1,$2,$3)',[member,ids,order]);
    const add=async(order,product)=>db.exec(`insert into order_items(order_id,product_id,crm_play_member_id,crm_play_benefit_id,unit_price_usd_snapshot,line_total_usd)
      values(${order},${product},${order},${product},0,0)`);
    await select(10,[11,10]);
    await add(10,11); await add(10,10);
    assert.deepEqual((await rows('select product_id,crm_coupon_discount_usd,line_total_usd from order_items where order_id=10 and crm_play_member_id is not null order by product_id')).map(r=>[r.product_id,Number(r.crm_coupon_discount_usd),Number(r.line_total_usd)]),[[10,3.5,0],[11,.5,3.5]]);
    assert.equal(Number(await scalar(`select sum(benefit_credit_usd) v from crm_play_redemptions where order_id=10 and status='reserved'`)),4);
    assert.equal(Number(await scalar(`select sum(advisor_charge_usd) v from crm_play_redemptions where order_id=10 and status='reserved'`)),.75);
    assert.equal(await scalar(`select benefit_status v from crm_play_members where id=10`),'reserved');
    await assert.rejects(select(10,[11],30),/reservado/);
    await select(10,[11],10);
    await db.exec(`begin;delete from order_items where order_id=10 and product_id=10;update order_items set pricing_origin_amount=0,line_total_usd=0 where order_id=10 and product_id=11;commit;`);
    assert.equal(Number(await scalar(`select sum(benefit_credit_usd) v from crm_play_redemptions where order_id=10 and status='reserved'`)),4);
    assert.equal(Number(await scalar(`select line_total_usd v from order_items where order_id=10 and product_id=11`)),0);
    await assert.rejects(db.exec(`update orders set fulfillment='pickup' where id=10`),/delivery/);
    await db.exec(`update orders set status='delivered' where id=10`);
    assert.equal(await scalar(`select status v from crm_play_redemptions where order_id=10 and status<>'voided'`),'redeemed');
    await assert.rejects(select(10,[11],10),/pedido|cannot select|reservado/);
    await assert.rejects(db.exec(`update crm_play_redemptions set advisor_charge_usd=0 where order_id=10 and status='redeemed'`),/inmutables/);
    await select(11,[12]);await add(11,12);
    assert.equal(Number(await scalar(`select line_total_usd v from order_items where order_id=11 and product_id=12`)),6.5);
    await db.exec(`update orders set status='cancelled' where id=11`);
    assert.equal(Number(await scalar(`select count(*) v from crm_play_redemptions where order_id=11 and status='reserved'`)),0);
    await select(12,[14]);await add(12,14);
    assert.equal(Number(await scalar(`select benefit_credit_usd v from crm_play_redemptions where order_id=12`)),1.1,'only actual expense, no cash remainder');
    await select(13,[15]);await add(13,15);
    assert.equal(Number(await scalar(`select crm_coupon_discount_usd v from order_items where order_id=13 and product_id=15`)),2.5,'native VES uses order FX');
    await db.exec(`update products set source_price_amount=350 where id=15;update order_items set notes='same coupon' where order_id=13 and product_id=15`);
    assert.equal(Number(await scalar(`select crm_coupon_discount_usd v from order_items where order_id=13 and product_id=15`)),2.5,'saved native gross survives catalog changes');
    await select(13,[15],13);
    await db.exec(`begin;delete from order_items where order_id=13 and product_id=15;
      insert into order_items(order_id,product_id,crm_play_member_id,crm_play_benefit_id) values(13,15,13,15);commit;`);
    assert.equal(Number(await scalar(`select crm_coupon_discount_usd v from order_items where order_id=13 and product_id=15`)),2.5,'replacement reloads native gross from audited reservation');
    await db.exec(`update order_items set crm_coupon_source_amount=99999,crm_coupon_discount_usd=99,line_total_usd=0 where order_id=13 and product_id=15`);
    assert.equal(Number(await scalar(`select crm_coupon_source_amount v from order_items where order_id=13 and product_id=15`)),250,'browser cannot forge a larger gross or discount');
    await assert.rejects(db.exec(`update order_items set qty=2 where order_id=13 and product_id=15`),/cantidad|producto final/);
    await db.exec(`delete from order_items where order_id=13 and product_id=15`);
    assert.equal(await scalar(`select benefit_status v from crm_play_members where id=13`),'available','removing coupon releases the customer');
    await select(14,[10]);await add(14,10);
    await db.exec(`update order_items set line_total_usd=14 where order_id=14 and product_id=13`);
    await assert.rejects(db.exec(`update orders set status='delivered' where id=14`),/al menos/);
    await select(15,[11,12]);
    await assert.rejects(db.exec(`begin;insert into order_items(order_id,product_id,crm_play_member_id,crm_play_benefit_id) values(15,11,15,11),(15,12,15,12);commit`),/solo env/);
    await db.exec('rollback');
    await db.exec(`select set_config('test.uid','00000000-0000-0000-0000-000000000002',false)`);
    await assert.rejects(select(16,[10]),/another advisor/);
    await db.exec(`select set_config('test.uid','00000000-0000-0000-0000-000000000001',false);select set_config('test.role','admin',false);
      update crm_plays set status='draft',selection_summary=jsonb_build_object('generated_at',now()),
        rules_snapshot=jsonb_set(rules_snapshot,'{coupon_draft,economics,review_status}','"pending"') where id=2;`);
    await assert.rejects(db.exec('select public.crm_confirm_play_v1(2)'),/costos/);
    const summary=(await rows('select public.crm_refresh_play_preview_summary_v1(2) v'))[0].v;
    assert.equal(summary.benefit_value_per_client_max_usd,4);assert.equal(summary.company_cost_per_client_max_usd,null);
    await db.exec(`create trigger coupon_options_guard before insert or update or delete on crm_play_benefits for each row execute function app_private.crm_play_benefit_guard_v2();
      insert into crm_play_benefits(id,play_id,product_id,sort_order) values(90,2,14,9);
      update crm_plays set status='draft' where id=1;`);
    await assert.rejects(db.exec('insert into crm_play_benefits(id,play_id,product_id,sort_order) values(91,1,14,9)'),/ocho alternativas/);
    assert.equal(await scalar(`select has_function_privilege('anon','public.crm_prepare_coupon_selection_v1(bigint,bigint[],bigint)','execute') v`),false);
  } finally { await db.close(); }
});
