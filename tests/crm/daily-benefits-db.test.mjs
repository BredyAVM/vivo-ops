import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('daily gifts: real PostgreSQL reservations, days, cancellation, channels and products-only minimum', async () => {
  const db = new PGlite();
  const advisor = '00000000-0000-0000-0000-000000000001';
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema app_private;
      create function auth.uid() returns uuid language sql as $$ select '${advisor}'::uuid $$;
      create function auth.jwt() returns jsonb language sql as $$ select '{"role":"service_role"}'::jsonb $$;
      create function auth.role() returns text language sql as $$ select 'service_role'::text $$;
      create function public.is_master_or_admin() returns boolean language sql as $$ select true $$;
      create function public.is_admin() returns boolean language sql as $$ select true $$;
      create function public.has_role(text) returns boolean language sql as $$ select true $$;
      create function app_private.order_item_operational_quantity_v1(jsonb,jsonb) returns boolean language sql as $$ select false $$;
      create function app_private.crm_order_has_validity_exception_v1(bigint,bigint) returns boolean language sql as $$ select false $$;
      create table profiles(id uuid primary key,full_name text);
      insert into profiles values ('${advisor}','Test Advisor');
      create table products(id bigint primary key,name text,sku text,type text default 'product',is_active boolean default true,extra_fields jsonb default '{}',base_price_usd numeric default 0,source_price_amount numeric default 0);
      create table orders(id bigint primary key,order_number text,client_id bigint,attributed_advisor_id uuid,status text default 'created',fulfillment text default 'pickup',source text default 'advisor',extra_fields jsonb default '{}',last_modified_by uuid);
      create table crm_plays(id bigint primary key,name text,description text,advisor_guidance text,status text,starts_at timestamptz,ends_at timestamptz,purchase_requirement_mode text default 'minimum_order',minimum_order_amount_usd numeric default 10,benefit_selection_mode text default 'single',rules_snapshot jsonb default '{}');
      create table crm_play_members(id bigint primary key,play_id bigint,client_id bigint,advisor_id_snapshot uuid,workflow_status text default 'pending',benefit_status text default 'available',benefit_reserved_at timestamptz,benefit_redeemed_at timestamptz,benefit_expired_at timestamptz,selected_play_benefit_id bigint,selected_benefit_at timestamptz,selected_benefit_by_user_id uuid);
      create table crm_play_benefits(id bigint primary key,play_id bigint,product_id bigint,quantity numeric,unit_benefit_value_usd numeric default 1,unit_advisor_cost_usd numeric default 0.5,unit_company_cost_usd numeric default 0.5,sort_order int default 0);
      create table crm_play_benefit_upgrades(id bigint primary key,play_id bigint,play_benefit_id bigint,target_product_id bigint,target_quantity numeric,customer_difference_usd_snapshot numeric);
      create table crm_play_member_benefit_selections(play_member_id bigint,play_benefit_id bigint,play_id bigint,selected_by_user_id uuid,selected_at timestamptz);
      create table crm_play_catalog_aliases(play_benefit_id bigint,source_product_id bigint,play_benefit_upgrade_id bigint);
      create table order_items(id bigint primary key,order_id bigint,product_id bigint,qty numeric default 1,crm_play_member_id bigint,crm_play_benefit_id bigint,crm_play_benefit_upgrade_id bigint,line_total_usd numeric,notes text,admin_price_override_usd numeric,override_unit_price_usd numeric,pricing_origin_currency text,pricing_origin_amount numeric,unit_price_usd_snapshot numeric,unit_price_bs_snapshot numeric,line_total_bs_snapshot numeric);
      create table crm_play_redemptions(id bigint generated always as identity primary key,play_member_id bigint,play_benefit_id bigint,play_benefit_upgrade_id bigint,order_id bigint,order_item_id bigint,product_id bigint,quantity numeric,status text,reserved_by_user_id uuid,reserved_at timestamptz,redeemed_by_user_id uuid,redeemed_at timestamptz,voided_at timestamptz,void_reason text,created_at timestamptz default now(),play_name_snapshot text,unit_benefit_value_usd numeric,unit_advisor_cost_usd numeric,unit_company_cost_usd numeric,benefit_value_usd numeric,benefit_credit_usd numeric,customer_paid_difference_usd numeric,advisor_charge_usd numeric,company_cost_usd numeric);
      create unique index crm_play_redemptions_active_member_benefit_unique on crm_play_redemptions(play_member_id,play_benefit_id) where status in ('reserved','redeemed') and play_benefit_id is not null;
      create table crm_play_member_events(play_member_id bigint,event_type text,from_status text,to_status text,note text,actor_user_id uuid,created_at timestamptz);
      create table app_private.crm_order_minimum_exceptions(order_id bigint,play_member_id bigint,benefit_fingerprint text,minimum_authorized_usd numeric,reason text,approved_at timestamptz,approved_by uuid);
      create table app_private.crm_order_validity_exceptions(id bigint,order_id bigint,play_member_id bigint,benefit_fingerprint text,authorized_through date,reason text,approved_at timestamptz,approved_by uuid);
    `);
    await db.exec(readFileSync(new URL('./fixtures/daily-benefit-installed-functions.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../../supabase/migrations/20261006141222_crm_daily_benefits_and_paid_products_minimum.sql',import.meta.url),'utf8'));
    await db.exec(`
      create trigger crm_order_items_guard before insert or update on order_items for each row execute function app_private.crm_order_item_guard_v1();
      create trigger crm_order_items_reserve_benefit after insert on order_items for each row when(new.crm_play_member_id is not null) execute function app_private.crm_reserve_order_item_benefit_v1();
      create trigger crm_order_items_release_reservation before delete on order_items for each row when(old.crm_play_member_id is not null) execute function app_private.crm_release_order_item_reservation_v1();
      create trigger crm_play_redemptions_guard before insert or update or delete on crm_play_redemptions for each row execute function app_private.crm_play_redemption_guard_v1();
      create trigger orders_finalize_crm_benefits_on_delivery after update of status on orders for each row execute function app_private.crm_finalize_order_benefits_on_delivery_v1();
      create trigger orders_void_crm_benefits_on_cancel after update of status on orders for each row execute function app_private.crm_void_play_redemptions_on_order_cancel_v1();
      insert into products(id,name,sku) values (1,'Food','FOOD'),(2,'Dondy','DONDY_1'),(3,'Delivery Zona 1','DEL_Z1'),(4,'Delivery Zona 2','DEL_Z2');
      insert into crm_plays(id,name,status) values (1,'Daily Pickup','active'),(2,'Daily Delivery','active'),(3,'Once','active');
      update crm_plays set benefit_recurrence_mode='daily',benefit_fulfillment=case when id=1 then 'pickup' else 'delivery_zone_1' end where id in (1,2);
      insert into crm_play_members(id,play_id,client_id,advisor_id_snapshot) values (1,1,1,'${advisor}'),(2,2,2,'${advisor}'),(3,3,3,'${advisor}');
      insert into crm_play_benefits(id,play_id,product_id,quantity) values (1,1,2,1),(2,2,3,1),(3,3,2,1);
      insert into crm_play_member_benefit_selections(play_member_id,play_benefit_id,play_id) values (1,1,1),(2,2,2),(3,3,3);
    `);
    const today=(await db.query("select (now() at time zone 'America/Caracas')::date::text d")).rows[0].d;
    const tomorrow=(await db.query("select ((now() at time zone 'America/Caracas')::date+1)::text d")).rows[0].d;
    const nextDay=(await db.query("select ((now() at time zone 'America/Caracas')::date+2)::text d")).rows[0].d;
    const order = async(id,day=today,member=1,channel='pickup',paid=10,shipping=0) => {
      await db.exec('begin');
      try {
        await db.query("insert into orders(id,order_number,client_id,attributed_advisor_id,fulfillment,extra_fields) values($1::bigint,$1::bigint::text,$2,$3,$4,jsonb_build_object('schedule',jsonb_build_object('date',$5::text)))",[id,member,advisor,channel,day]);
        await db.query("insert into order_items(id,order_id,product_id,line_total_usd) values($1,$2,1,$3)",[id*10,id,paid]);
        if(shipping) await db.query("insert into order_items(id,order_id,product_id,line_total_usd) values($1,$2,3,$3)",[id*10+2,id,shipping]);
        await db.query("insert into order_items(id,order_id,product_id,crm_play_member_id,crm_play_benefit_id,line_total_usd) values($1,$2,$3,$4,$4,0)",[id*10+1,id,member===2?3:2,member]);
        await db.exec('commit');
      } catch(e) { await db.exec('rollback'); throw e; }
    };
    const state=async(id)=>(await db.query("select app_private.crm_order_minimum_state_v1($1) v",[id])).rows[0].v[0];
    await order(1);
    await assert.rejects(()=>order(2),/reservado|unique/i);
    assert.equal((await db.query("select count(*)::int n from orders where id=2")).rows[0].n,0);
    await order(3,tomorrow);
    await db.exec("update orders set status='delivered' where id=1");
    await assert.rejects(()=>order(4),/reservado|unique/i);
    // Another day remains selectable after a delivered benefit.
    await db.query("select public.crm_set_play_benefits_v2(1,array[1]::bigint[])");
    await order(5,nextDay);
    assert.ok((await db.query("select benefit_redeemed_at from crm_play_members where id=1")).rows[0].benefit_redeemed_at);
    assert.equal((await state(5)).eligible,true);
    await assert.rejects(()=>db.query("update orders set extra_fields=jsonb_build_object('schedule',jsonb_build_object('date',$1::text)) where id=5",[tomorrow]),/beneficio reservado/i);
    assert.equal((await db.query("select benefit_day::text d from crm_play_redemptions where order_id=5")).rows[0].d,nextDay);
    await db.exec("update orders set status='cancelled' where id=3");
    await db.query("update orders set extra_fields=jsonb_build_object('schedule',jsonb_build_object('date',$1::text)) where id=5",[tomorrow]);
    await db.exec("delete from order_items where id=51");
    await order(6,tomorrow);
    await assert.rejects(()=>order(7,nextDay,1,'delivery'),/retirar/);
    await order(8,today,2,'delivery');
    await assert.rejects(()=>order(9,tomorrow,2,'pickup'),/zona 1/i);
    await assert.rejects(()=>db.exec("update orders set fulfillment='delivery' where id=6"),/retirar/);
    // Delivery is not eligible consumption, even in a legacy once-per-play campaign.
    await order(10,today,3,'delivery',8,2);
    const minimum=await state(10);
    assert.equal(Number(minimum.commercialUsd),8); assert.equal(minimum.eligible,false);
    await assert.rejects(()=>db.exec("update orders set status='delivered' where id=10"),/requiere una compra/);
    await assert.rejects(()=>order(11,tomorrow,3,'delivery'),/reservado/i);
    // The installed deferred minimum guard also rejects an invalid NEW order,
    // not just its eventual delivery. Gift-first insert order remains atomic.
    const minimumMigration=readFileSync(new URL('../../supabase/migrations/20260930125941_crm_order_minimum_lifecycle_guard.sql',import.meta.url),'utf8');
    const deferredDefinition=minimumMigration.slice(minimumMigration.indexOf('create or replace function app_private.crm_order_minimum_deferred_guard_v1()'),minimumMigration.indexOf('create or replace function app_private.crm_lock_order_minimum_edit_v1()'));
    await db.exec(deferredDefinition);
    await db.exec(`create constraint trigger crm_order_minimum_after_order after insert or update on orders deferrable initially deferred for each row execute function app_private.crm_order_minimum_deferred_guard_v1();
      create constraint trigger crm_order_minimum_after_items after insert or update or delete on order_items deferrable initially deferred for each row execute function app_private.crm_order_minimum_deferred_guard_v1();`);
    await assert.rejects(()=>order(12,nextDay,2,'delivery',8),/requiere una compra/);
    // Financial cost is reserved until delivery, once per actual redemption.
    assert.equal((await db.query("select count(*)::int n from crm_play_redemptions where status='redeemed'")).rows[0].n,1);
    assert.equal(Number((await db.query("select sum(advisor_charge_usd) v from crm_play_redemptions where status='redeemed'")).rows[0].v),0.5);
    await assert.rejects(()=>db.exec("update crm_play_redemptions set benefit_day=benefit_day+1 where order_id=1"),/reserva diaria/i);
    assert.equal((await db.query("select has_function_privilege('authenticated','app_private.crm_sync_daily_order_day_v1()','execute') v")).rows[0].v,false);
  } finally { await db.close(); }
});
