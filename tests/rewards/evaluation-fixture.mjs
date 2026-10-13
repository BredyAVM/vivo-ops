import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const admin='00000000-0000-0000-0000-000000000001';
const advisor='00000000-0000-0000-0000-000000000002';
const other='00000000-0000-0000-0000-000000000003';
const counter='00000000-0000-0000-0000-000000000004';
const migration=readFileSync(new URL('../../supabase/migrations/20261013155128_advisor_award_evaluation_preview.sql',import.meta.url),'utf8');
export async function setup(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function public.is_admin() returns boolean language sql stable security definer set search_path='' as $$select auth.uid()='${admin}'::uuid$$;
 create table profiles(id uuid,full_name text,is_active boolean,receives_commissions boolean);
 create table user_roles(user_id uuid,role text);
 create table clients(id bigint,full_name text,client_type text);
 create table orders(id bigint,extra_fields jsonb);
 create table commercial_order_facts(fact_key text,fact_origin text,source_record_id bigint,source_control text,client_id bigint,purchased_at timestamptz,attributed_advisor_id uuid,advisor_name_snapshot text,net_total_usd numeric,event_kind text);
 insert into profiles values('${advisor}','Advisor',true,true),('${other}','Other',true,true),('${counter}','Counter',true,false);
 insert into user_roles values('${advisor}','advisor'),('${other}','advisor'),('${counter}','counter');
 insert into clients values(1,'Assigned','assigned'),(2,'Own','own'),(3,'Company mislabeled own','own'),(4,'Company assigned','assigned'),(5,'Ambiguous','own'),(6,'Mature','own');
 `);
 await db.exec(migration);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[admin]);
 const insert=async(id,date,owner,price=10,key)=>{
  const fact=key??'f'+id+'-'+date+'-'+owner;
  await db.query(`insert into commercial_order_facts values($1,'live',1,$1,$2,$3::timestamptz,$4::uuid,'Advisor',$5,'purchase')`,[fact,id,date+'T12:00:00-04:00',owner,price]);
 };
 await insert(1,'2026-07-10',advisor);await insert(1,'2026-08-10',advisor);await insert(1,'2026-09-10',advisor);await insert(1,'2026-09-11',other,1000);
 await insert(2,'2026-08-10',advisor);await insert(2,'2026-09-10',advisor);await insert(2,'2026-09-11',advisor,0);
 await insert(3,'2026-05-01',counter);await insert(3,'2026-05-02',counter);await insert(3,'2026-09-05',advisor);await insert(3,'2026-09-06',advisor);
 await insert(4,'2026-08-01',counter);await insert(4,'2026-08-05',advisor);await insert(4,'2026-09-05',advisor);
 await insert(5,'2026-08-10',advisor);await insert(5,'2026-08-10',other);
 await insert(6,'2026-01-01',advisor);await insert(6,'2026-08-10',advisor);await insert(6,'2026-09-10',advisor);await insert(6,'2026-09-10',advisor,10,'same-day-second');
 return db;
}
export {admin,advisor,other,counter};

