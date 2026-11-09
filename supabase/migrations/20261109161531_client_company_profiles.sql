-- Saved companies are independent of the immutable document snapshots in orders.
create table public.client_company_profiles (
  id uuid primary key default gen_random_uuid(),
  client_id bigint not null references public.clients(id) on delete restrict,
  label text not null check (length(btrim(label)) between 1 and 80),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  is_default boolean not null default false,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
create unique index client_company_profiles_label_unique on public.client_company_profiles(client_id, lower(btrim(label)));
create unique index client_company_profiles_one_default on public.client_company_profiles(client_id) where is_default;
alter table public.client_company_profiles enable row level security;
revoke all on public.client_company_profiles from public, anon, authenticated;
grant select on public.client_company_profiles to authenticated;
create policy client_company_profiles_staff_read on public.client_company_profiles for select to authenticated
using ((select public.is_master_or_admin()) or (select public.has_role('advisor')));

-- Only current saved client data is imported, not conflicting historical order snapshots.
insert into public.client_company_profiles(client_id,label,data,is_default)
select id, 'Principal', jsonb_build_object(
  'invoiceCompanyName',coalesce(billing_company_name,''), 'invoiceTaxId',coalesce(billing_tax_id,''),
  'invoiceAddress',coalesce(billing_address,''), 'invoicePhone',coalesce(billing_phone,''),
  'deliveryNoteName',coalesce(delivery_note_name,''), 'deliveryNoteDocumentId',coalesce(delivery_note_document_id,''),
  'deliveryNoteAddress',coalesce(delivery_note_address,''), 'deliveryNotePhone',coalesce(delivery_note_phone,'')
), true from public.clients where coalesce(
  nullif(btrim(billing_company_name),''),nullif(btrim(billing_tax_id),''),nullif(btrim(billing_address),''),nullif(btrim(billing_phone),''),
  nullif(btrim(delivery_note_name),''),nullif(btrim(delivery_note_document_id),''),nullif(btrim(delivery_note_address),''),nullif(btrim(delivery_note_phone),'')
) is not null;

create function app_private.save_client_company_profile_v1(
  p_client_id bigint, p_id uuid, p_expected_version integer, p_label text, p_data jsonb, p_is_default boolean
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  previous public.client_company_profiles%rowtype;
  clean_data jsonb := '{}'::jsonb;
  field_name text;
  field_value text;
  clean_label text := btrim(p_label);
  make_default boolean;
  fields constant text[] := array['invoiceCompanyName','invoiceTaxId','invoiceAddress','invoicePhone',
    'deliveryNoteName','deliveryNoteDocumentId','deliveryNoteAddress','deliveryNotePhone'];
begin
  if auth.uid() is null or not (public.is_master_or_admin() or public.has_role('advisor')) then
    raise exception 'No tienes permiso para gestionar empresas.' using errcode='42501';
  end if;
  if p_id is null or p_client_id is null or p_label is null or length(clean_label) not between 1 and 80
    or p_is_default is null or p_data is null or jsonb_typeof(p_data) <> 'object' then
    raise exception 'Datos de empresa inválidos.' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_data) k where not (k = any(fields))) then
    raise exception 'Datos de empresa inválidos.' using errcode='22023';
  end if;
  foreach field_name in array fields loop
    if p_data ? field_name and jsonb_typeof(p_data->field_name) <> 'string' then
      raise exception 'Datos de empresa inválidos.' using errcode='22023';
    end if;
    field_value := btrim(coalesce(p_data->>field_name,''));
    if length(field_value) > (case when field_name in ('invoiceAddress','deliveryNoteAddress') then 1000 else 250 end) then
      raise exception 'Datos de empresa demasiado largos.' using errcode='22023';
    end if;
    clean_data := clean_data || jsonb_build_object(field_name,field_value);
  end loop;
  if not exists(select 1 from jsonb_each_text(clean_data) entry where entry.value <> '') then
    raise exception 'Agrega los datos de factura o nota de entrega.' using errcode='22023';
  end if;
  -- Serialize saves for one client, including simultaneous default changes.
  perform id from public.clients where id=p_client_id for update;
  if not found then raise exception 'Cliente no disponible.' using errcode='42501'; end if;
  select * into previous from public.client_company_profiles where id=p_id;
  if found then
    if previous.client_id <> p_client_id then raise exception 'Empresa no disponible.' using errcode='42501'; end if;
    -- A retried creation reuses its UUID without creating a second company or reverting newer changes.
    if p_expected_version is null then
      if previous.version <> 1 or previous.label <> clean_label or previous.data <> clean_data then
        raise exception 'La empresa cambió. Recarga para continuar.' using errcode='40001';
      end if;
      return (select coalesce(jsonb_agg(to_jsonb(p) order by p.is_default desc,p.label),'[]'::jsonb)
        from public.client_company_profiles p where client_id=p_client_id);
    end if;
    if previous.version <> p_expected_version then
      raise exception 'La empresa cambió. Recarga para continuar.' using errcode='40001';
    end if;
  elsif p_expected_version is not null then
    raise exception 'La empresa cambió. Recarga para continuar.' using errcode='40001';
  end if;
  make_default := p_is_default or not exists(
    select 1 from public.client_company_profiles where client_id=p_client_id and is_default and id<>p_id
  );
  if make_default then
    update public.client_company_profiles set is_default=false,version=version+1,updated_at=now(),updated_by=auth.uid()
      where client_id=p_client_id and is_default and id<>p_id;
  end if;
  if previous.id is not null then
    update public.client_company_profiles set label=clean_label,data=clean_data,is_default=make_default,
      version=version+1,updated_at=now(),updated_by=auth.uid() where id=p_id;
  else
    insert into public.client_company_profiles(id,client_id,label,data,is_default,created_by,updated_by)
      values(p_id,p_client_id,clean_label,clean_data,make_default,auth.uid(),auth.uid());
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(p) order by p.is_default desc,p.label),'[]'::jsonb)
    from public.client_company_profiles p where client_id=p_client_id);
end;
$$;
revoke all on function app_private.save_client_company_profile_v1(bigint,uuid,integer,text,jsonb,boolean) from public,anon,authenticated;
grant execute on function app_private.save_client_company_profile_v1(bigint,uuid,integer,text,jsonb,boolean) to authenticated;

create function public.save_client_company_profile_v1(
  p_client_id bigint,p_id uuid,p_expected_version integer,p_label text,p_data jsonb,p_is_default boolean
) returns jsonb language sql security invoker set search_path = '' as $$
  select app_private.save_client_company_profile_v1(p_client_id,p_id,p_expected_version,p_label,p_data,p_is_default);
$$;
revoke all on function public.save_client_company_profile_v1(bigint,uuid,integer,text,jsonb,boolean) from public,anon;
grant execute on function public.save_client_company_profile_v1(bigint,uuid,integer,text,jsonb,boolean) to authenticated;
