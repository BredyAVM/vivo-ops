-- Explicit aliases are campaign-scoped; names never determine eligibility.
create table public.crm_play_catalog_aliases (
  play_benefit_id bigint not null references public.crm_play_benefits(id) on delete cascade,
  source_product_id bigint not null references public.products(id) on delete restrict,
  play_benefit_upgrade_id bigint references public.crm_play_benefit_upgrades(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique nulls not distinct (source_product_id,play_benefit_id,play_benefit_upgrade_id)
);
alter table public.crm_play_catalog_aliases enable row level security;
revoke all on public.crm_play_catalog_aliases from public,anon,authenticated;
grant all on public.crm_play_catalog_aliases to service_role;

-- Reviewed September aliases. Resolve business keys, never generated IDs.
insert into public.crm_play_catalog_aliases(play_benefit_id,source_product_id,play_benefit_upgrade_id)
select b.id,source.id,u.id
from (values
 ('Aniversario · septiembre de 2026','ANIVERSARIO_SINGLEPACK','SINGLE_6'),
 ('Loyal · septiembre de 2026','LOYAL_SINGLE_6','SINGLE_6'),
 ('Loyal · septiembre de 2026','LOYAL_SINGLE_8','SINGLE_8'),
 ('Loyal · septiembre de 2026','LOYAL_SINGLE_10','SINGLE_10')
) mapping(play_name,source_sku,target_sku)
join public.crm_plays p on p.name=mapping.play_name
join public.crm_play_benefits b on b.play_id=p.id
join public.products source on source.sku=mapping.source_sku
join public.products target on target.sku=mapping.target_sku
left join public.crm_play_benefit_upgrades u on u.play_benefit_id=b.id and u.target_product_id=target.id
where b.product_id=target.id or u.id is not null;

create function app_private.crm_catalog_gift_candidates_v1(p_client_id bigint,p_advisor_id uuid,p_product_id bigint)
returns table(play_member_id bigint,play_benefit_id bigint,play_benefit_upgrade_id bigint,
  play_name text,benefit_status text,target_product_id bigint,quantity numeric,
  customer_difference_usd numeric,purchase_requirement_mode text)
language sql stable set search_path='' as $$
  with options as (
    select b.id benefit_id,b.play_id,b.product_id target_id,b.quantity qty,
      null::bigint upgrade_id,0::numeric difference
    from public.crm_play_benefits b
    where b.product_id=p_product_id or exists(
      select 1 from public.crm_play_catalog_aliases a
      where a.play_benefit_id=b.id and a.source_product_id=p_product_id and a.play_benefit_upgrade_id is null)
    union
    select b.id,b.play_id,u.target_product_id,u.target_quantity,u.id,u.customer_difference_usd_snapshot
    from public.crm_play_benefits b join public.crm_play_benefit_upgrades u on u.play_benefit_id=b.id
    where u.target_product_id=p_product_id or exists(
      select 1 from public.crm_play_catalog_aliases a
      where a.play_benefit_id=b.id and a.source_product_id=p_product_id and a.play_benefit_upgrade_id=u.id)
  )
  select m.id,o.benefit_id,o.upgrade_id,p.name,m.benefit_status,o.target_id,o.qty,o.difference,p.purchase_requirement_mode
  from options o join public.crm_plays p on p.id=o.play_id
  join public.crm_play_members m on m.play_id=p.id and m.client_id=p_client_id and m.advisor_id_snapshot=p_advisor_id
  join public.products source on source.id=p_product_id
  join public.products target on target.id=o.target_id
  where source.type::text='gambit' and source.is_active
    and source.extra_fields->>'catalog_access_scope'='advisor_gift'
    and target.is_active
    and coalesce(target.extra_fields->>'catalog_access_scope','') not in ('advisor_gift_only','gambit_disabled','admin_internal')
    and m.workflow_status not in ('removed','not_applicable')
    and m.benefit_status in ('available','reserved','redeemed')
    and p.status='active' and (p.starts_at is null or now()>=p.starts_at) and (p.ends_at is null or now()<p.ends_at)
  order by m.id,o.benefit_id,o.upgrade_id;
$$;
revoke all on function app_private.crm_catalog_gift_candidates_v1(bigint,uuid,bigint) from public,anon,authenticated;

create function app_private.crm_resolve_catalog_gift_v1(p_client_id bigint,p_product_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  if auth.uid() is null or not public.has_role('advisor') then
    raise exception 'Solo el asesor puede consultar los beneficios de su cartera.' using errcode='42501';
  end if;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into result
  from app_private.crm_catalog_gift_candidates_v1(p_client_id,auth.uid(),p_product_id) c;
  return result;
end;
$$;
revoke all on function app_private.crm_resolve_catalog_gift_v1(bigint,bigint) from public,anon;
grant execute on function app_private.crm_resolve_catalog_gift_v1(bigint,bigint) to authenticated;
create function public.crm_resolve_catalog_gift_v1(p_client_id bigint,p_product_id bigint)
returns jsonb language sql security invoker set search_path='' as $$
  select app_private.crm_resolve_catalog_gift_v1(p_client_id,p_product_id);
$$;
revoke all on function public.crm_resolve_catalog_gift_v1(bigint,bigint) from public,anon;
grant execute on function public.crm_resolve_catalog_gift_v1(bigint,bigint) to authenticated;

-- Safety net for older clients and all order-entry surfaces. Explicitly linked
-- lines retain the existing lifecycle guards. No update of past orders occurs.
create function app_private.crm_auto_link_catalog_gift_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare ord record; choice record; matches jsonb; choice_count integer;
begin
  if new.crm_play_member_id is not null or new.crm_play_benefit_id is not null
    or new.crm_play_benefit_upgrade_id is not null then return new; end if;
  if not exists(select 1 from public.products where id=new.product_id and type::text='gambit'
    and extra_fields->>'catalog_access_scope'='advisor_gift') then return new; end if;
  select client_id,attributed_advisor_id,status::text into ord from public.orders where id=new.order_id;
  select coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) into matches
    from app_private.crm_catalog_gift_candidates_v1(ord.client_id,ord.attributed_advisor_id,new.product_id) c;
  if jsonb_array_length(matches)=0 then return new; end if;
  if ord.status in ('delivered','cancelled') then
    raise exception 'No se puede vincular un nuevo beneficio a un pedido cerrado.' using errcode='55000';
  end if;
  if auth.uid() is null and coalesce(auth.role(),'')<>'service_role' then
    raise exception 'La vinculación automática requiere una sesión autorizada.' using errcode='42501';
  end if;
  if auth.uid() is not null and auth.uid() is distinct from ord.attributed_advisor_id and not public.is_master_or_admin() then
    raise exception 'La jugada no corresponde al asesor de la orden.' using errcode='42501';
  end if;
  select count(*) into choice_count from jsonb_array_elements(matches) c where c->>'benefit_status'='available';
  if choice_count=0 then
    raise exception 'Este obsequio ya está reservado o aplicado en la jugada del cliente. Revisa su pedido antes de repetirlo.' using errcode='55000';
  elsif choice_count>1 then
    raise exception 'El obsequio coincide con varias jugadas. Selecciona cuál aplicar antes de guardar.' using errcode='22023';
  end if;
  select * into choice from jsonb_to_recordset(matches) as c(play_member_id bigint,play_benefit_id bigint,
    play_benefit_upgrade_id bigint,benefit_status text,target_product_id bigint,quantity numeric,
    customer_difference_usd numeric,purchase_requirement_mode text) where benefit_status='available';
  if new.qty is distinct from choice.quantity then
    raise exception 'La cantidad no coincide con el beneficio de la jugada. Agrégalo una sola vez.' using errcode='22023';
  end if;
  -- Never silently change a paid quote or bypass minimum-purchase pricing.
  -- Updated UI prepares these explicitly, at the price displayed to the advisor.
  if choice.purchase_requirement_mode<>'none' or choice.customer_difference_usd<>0
    or coalesce(new.line_total_usd,0)<>0 then
    raise exception 'Este producto tiene condiciones de jugada. Vuelve a seleccionarlo con la pantalla actualizada para revisar su precio.' using errcode='22023';
  end if;
  perform public.crm_set_play_benefits_v2(choice.play_member_id,array[choice.play_benefit_id]);
  new.product_id:=choice.target_product_id;
  new.crm_play_member_id:=choice.play_member_id;
  new.crm_play_benefit_id:=choice.play_benefit_id;
  new.crm_play_benefit_upgrade_id:=choice.play_benefit_upgrade_id;
  select sku,name into new.sku_snapshot,new.product_name_snapshot from public.products where id=new.product_id;
  return new;
end;
$$;
revoke all on function app_private.crm_auto_link_catalog_gift_v1() from public,anon,authenticated;
create trigger crm_00_auto_link_catalog_gift before insert on public.order_items
for each row execute function app_private.crm_auto_link_catalog_gift_v1();
