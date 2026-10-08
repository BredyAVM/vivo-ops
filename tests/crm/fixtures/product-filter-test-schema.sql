create role anon;create role authenticated;create role service_role;
      create schema app_private;create schema auth;
      create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      create function auth.jwt() returns jsonb language sql as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function is_master_or_admin() returns boolean language sql as $$select auth.uid() is not null$$;
      create function app_private.crm_play_has_overlap_conflict_v1(bigint,bigint) returns boolean language sql as $$select false$$;
      select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
      create table profiles(id uuid primary key,full_name text,is_active boolean default true);
      create table user_roles(user_id uuid,role text);
      insert into profiles values('00000000-0000-0000-0000-000000000001','Test Advisor',true);
      insert into user_roles values('00000000-0000-0000-0000-000000000001','advisor'),('00000000-0000-0000-0000-000000000001','admin');
      create table clients(id bigint primary key,full_name text,is_active boolean default true,primary_advisor_id uuid default '00000000-0000-0000-0000-000000000001');
      insert into clients(id,full_name) select n,'Client '||n from generate_series(1,8) n;
      create table crm_plays(id bigint primary key,name text,status text,starts_at timestamptz,ends_at timestamptz,
        rules_snapshot jsonb default '{}',metric_window integer default 6,selection_summary jsonb,
        benefit_recurrence_mode text default 'once',benefit_fulfillment text default 'any',created_by_user_id uuid default '00000000-0000-0000-0000-000000000001');
      create table crm_play_benefits(id bigint,play_id bigint);
      create table crm_play_benefit_upgrades(id bigint,play_id bigint);
      create table crm_play_redemptions(id bigint,play_member_id bigint,status text);
      create table crm_play_member_events(id bigint,play_member_id bigint,event_type text);
      create table crm_play_amendments(play_id bigint,amendment_type text,client_id bigint,advisor_id_snapshot uuid,previous_values jsonb,new_values jsonb,reason text,created_by_user_id uuid);
      create table crm_play_members(id bigint generated always as identity primary key,play_id bigint,client_id bigint,
        advisor_id_snapshot uuid,eligible_at timestamptz,workflow_status text default 'pending',benefit_status text default 'available',
        first_purchase_on date,last_purchase_on date,purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,
        cadence_days numeric,cadence_window integer,last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,
        days_since_last_purchase integer,used_pickup boolean,used_delivery boolean,decision_snapshot jsonb,eligibility_reasons text[],play_launched_at timestamptz);
      create index crm_members_client_launch_time_idx on crm_play_members(client_id,play_launched_at) where play_launched_at is not null;
      create function crm_client_metrics_v1(integer,timestamptz) returns table(client_id bigint,first_purchase_on date,last_purchase_on date,
        purchase_count integer,net_revenue_usd numeric,average_ticket_usd numeric,cadence_days numeric,cadence_window_used integer,
        last_advisor_id uuid,last_advisor_name_snapshot text,last_gift_on date,days_since_last_purchase integer,used_pickup boolean,used_delivery boolean)
      language sql as $$select id,'2024-01-01'::date,'2026-09-20'::date,30,300::numeric,10::numeric,30::numeric,6,'00000000-0000-0000-0000-000000000001'::uuid,'Advisor',null::date,10,true,false from public.clients$$;
