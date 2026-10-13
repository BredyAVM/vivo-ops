-- Keep admin commands in the same lock order; allow FK checks to share profile keys.
create or replace function public.reward_save_draft_v1(p_payload jsonb,p_request_token uuid,p_draft_id bigint default null,p_expected_version integer default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid(); v_advisor uuid; v_title text; v_category text; v_period date;
  v_kind text; v_mode text; v_purposes text[]; v_amount numeric; v_product bigint;
  v_product_name text; v_scope text; v_ids bigint[]; v_names text[]; v_expires date; v_note text;
  v_row public.advisor_reward_drafts%rowtype; v_before jsonb; v_after jsonb; v_existing_id bigint;
begin
  if v_uid is null or not public.is_admin() then raise exception 'Solo el administrador puede diseñar premios.'; end if;
  if p_request_token is null or p_payload is null or jsonb_typeof(p_payload)<>'object' then raise exception 'Diseño inválido.'; end if;
  v_advisor:=(p_payload->>'advisorId')::uuid;
  if not exists(select 1 from public.profiles p join public.user_roles r on r.user_id=p.id
    where p.id=v_advisor and p.is_active and r.role='advisor') then raise exception 'Selecciona un asesor activo.'; end if;
  v_title:=btrim(p_payload->>'title'); v_category:=p_payload->>'category';
  if coalesce(p_payload->>'period','')!~'^\d{4}-\d{2}$' then raise exception 'Selecciona mes y año.'; end if;
  v_period:=((p_payload->>'period')||'-01')::date;
  v_kind:=p_payload->>'kind'; v_mode:=p_payload->>'mode';
  if jsonb_typeof(p_payload->'purposes') is distinct from 'array' or jsonb_array_length(p_payload->'purposes') not between 1 and 3 then
    raise exception 'Selecciona usos compatibles con la modalidad.'; end if;
  select array_agg(value order by value) into v_purposes from jsonb_array_elements_text(p_payload->'purposes');
  if cardinality(v_purposes)<>(select count(distinct x) from unnest(v_purposes) x) then raise exception 'No repitas usos.'; end if;
  v_amount:=(p_payload->>'amount')::numeric;
  if v_amount is null or v_amount<=0 or v_amount>100000 or v_amount<>round(v_amount,2) then raise exception 'Monto o cantidad inválidos.'; end if;
  v_product:=nullif(p_payload->>'productId','')::bigint;
  v_scope:=p_payload->>'productScope';
  if jsonb_typeof(p_payload->'allowedProductIds') is distinct from 'array' or jsonb_array_length(p_payload->'allowedProductIds')>50 then
    raise exception 'Selecciona hasta 50 productos.'; end if;
  select coalesce(array_agg(value::bigint order by value::bigint),'{}'::bigint[]) into v_ids
    from jsonb_array_elements_text(p_payload->'allowedProductIds');
  if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids) x) then raise exception 'No repitas productos.'; end if;
  select coalesce(array_agg(p.name order by p.id),'{}'::text[]) into v_names
    from public.products p where p.id=any(v_ids) and p.is_active;
  if cardinality(v_names)<>cardinality(v_ids) then raise exception 'Hay productos inexistentes o inactivos.'; end if;
  if v_product is not null then
    select name into v_product_name from public.products where id=v_product and is_active;
    if v_product_name is null then raise exception 'Selecciona un producto activo.'; end if;
  end if;
  v_expires:=nullif(p_payload->>'expiresOn','')::date; v_note:=btrim(coalesce(p_payload->>'note',''));
  -- Serialize retries on the issuing administrator, before draft locks.
  perform 1 from public.profiles where id=v_uid for no key update;
  select id into v_existing_id from public.advisor_reward_drafts where created_by=v_uid and request_token=p_request_token;
  if p_draft_id is null and v_existing_id is not null then
    select * into v_row from public.advisor_reward_drafts where id=v_existing_id;
    if v_row.status<>'draft' or v_row.advisor_id<>v_advisor or v_row.title is distinct from v_title
      or v_row.category is distinct from v_category or v_row.period is distinct from v_period
      or v_row.kind is distinct from v_kind or v_row.mode is distinct from v_mode or v_row.purposes is distinct from v_purposes
      or v_row.amount is distinct from v_amount or v_row.product_id is distinct from v_product
      or v_row.product_scope is distinct from v_scope or v_row.allowed_product_ids is distinct from v_ids
      or v_row.expires_on is distinct from v_expires or v_row.note is distinct from v_note then
      raise exception 'Esta solicitud ya se utilizó con un diseño diferente.';
    end if;
    return jsonb_build_object('id',v_row.id,'version',v_row.version,'status','draft');
  end if;
  perform set_config('app.reward_draft_command','design',true);
  if p_draft_id is null then
    insert into public.advisor_reward_drafts(advisor_id,created_by,request_token,title,category,period,kind,mode,purposes,amount,
      product_id,product_name_snapshot,product_scope,allowed_product_ids,product_names_snapshot,expires_on,note)
    values(v_advisor,v_uid,p_request_token,v_title,v_category,v_period,v_kind,v_mode,v_purposes,v_amount,
      v_product,v_product_name,v_scope,v_ids,v_names,v_expires,v_note) returning * into v_row;
  else
    select * into v_row from public.advisor_reward_drafts where id=p_draft_id for update;
    if not found or v_row.status<>'draft' then raise exception 'El diseño no está disponible para editar.'; end if;
    if p_expected_version is null or v_row.version<>p_expected_version then raise exception 'El diseño cambió. Actualiza antes de guardar.'; end if;
    if v_row.advisor_id<>v_advisor then raise exception 'No se puede cambiar el asesor de un diseño existente.'; end if;
    v_before:=to_jsonb(v_row);
    update public.advisor_reward_drafts set title=v_title,category=v_category,period=v_period,kind=v_kind,mode=v_mode,purposes=v_purposes,
      amount=v_amount,product_id=v_product,product_name_snapshot=v_product_name,product_scope=v_scope,allowed_product_ids=v_ids,
      product_names_snapshot=v_names,expires_on=v_expires,note=v_note,version=version+1,updated_at=now()
      where id=p_draft_id returning * into v_row;
  end if;
  v_after:=to_jsonb(v_row);
  insert into public.advisor_reward_draft_events(draft_id,actor_id,event_type,reason,before_snapshot,after_snapshot)
    values(v_row.id,v_uid,case when v_before is null then 'created' else 'updated' end,'Diseño de premio; todavía no emitido.',v_before,v_after);
  return jsonb_build_object('id',v_row.id,'version',v_row.version,'status','draft');
end; $$;

create or replace function public.reward_cancel_draft_v1(p_draft_id bigint,p_expected_version integer,p_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_row public.advisor_reward_drafts%rowtype; v_before jsonb;
begin
  if v_uid is null or not public.is_admin() then raise exception 'Solo el administrador puede cancelar diseños.'; end if;
  if coalesce(length(btrim(p_reason)),0) not between 10 and 500 then raise exception 'Justifica la cancelación en 10 a 500 caracteres.'; end if;
  -- Same lock order as save; NO KEY UPDATE permits foreign-key KEY SHARE checks.
  perform 1 from public.profiles where id=v_uid for no key update;
  select * into v_row from public.advisor_reward_drafts where id=p_draft_id for update;
  if not found or v_row.status<>'draft' then raise exception 'El diseño no está disponible.'; end if;
  if p_expected_version is null or v_row.version<>p_expected_version then raise exception 'El diseño cambió. Actualiza antes de cancelar.'; end if;
  v_before:=to_jsonb(v_row);
  perform set_config('app.reward_draft_command','design',true);
  update public.advisor_reward_drafts set status='cancelled',version=version+1,updated_at=now() where id=p_draft_id returning * into v_row;
  insert into public.advisor_reward_draft_events(draft_id,actor_id,event_type,reason,before_snapshot,after_snapshot)
    values(v_row.id,v_uid,'cancelled',btrim(p_reason),v_before,to_jsonb(v_row));
  return jsonb_build_object('id',v_row.id,'status','cancelled');
end; $$;
revoke all on function public.reward_save_draft_v1(jsonb,uuid,bigint,integer),public.reward_cancel_draft_v1(bigint,integer,text) from public,anon;
grant execute on function public.reward_save_draft_v1(jsonb,uuid,bigint,integer),public.reward_cancel_draft_v1(bigint,integer,text) to authenticated;
