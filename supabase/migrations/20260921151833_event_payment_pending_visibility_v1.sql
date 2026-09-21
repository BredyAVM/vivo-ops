-- An old event receiving a payment must return to the scoped recent list used
-- by Master's action inbox. Preserve the event and order's actual dates.
do $$ declare definition text; marker text:=$marker$  insert into public.order_timeline_events(order_id,order_number,event_type,event_group,title,message,severity,actor_user_id,payload)$marker$; begin
  definition:=pg_get_functiondef('app_private.event_payment_command_v1(bigint,text,jsonb)'::regprocedure);
  if strpos(definition,marker)=0 then raise exception 'Event payment notification contract changed'; end if;
  execute replace(definition,marker,E'  update public.advisor_order_drafts set updated_at=clock_timestamp() where id=root.id;\n'||marker);
end $$;
