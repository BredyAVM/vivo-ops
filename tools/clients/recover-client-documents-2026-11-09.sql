-- Explicitly authorized recovery of 14 non-conflicting client document profiles.
-- Source values remain in the historical orders. No fiscal values are embedded here.
-- Default ROLLBACK. No permanent schema changes or trigger bypasses.
begin isolation level repeatable read;
set local lock_timeout='5s';
set local statement_timeout='25s';

do $repair$
declare
  actor constant uuid := '8c296814-8b98-48d4-8db1-ce27b4c808eb';
  target record;
  c public.clients%rowtype;
  filled public.clients%rowtype;
  o public.orders%rowtype;
  before_data jsonb;
  data jsonb;
  patch jsonb;
  field record;
  current_value text;
  seen integer:=0;
  field_count integer:=0;
  excluded_before jsonb;
begin
  perform set_config('request.jwt.claim.sub',actor::text,true);
  if public.is_admin() is not true then raise exception 'Expected administrative recovery context.'; end if;
  select jsonb_agg(to_jsonb(x) order by id) into excluded_before
    from public.clients x where id in (2117,3718);
  for target in
    select * from (values
      (6273,3272,'invoice'),(6248,22,'invoice'),(631,156,'invoice'),
      (6275,343,'invoice'),(3798,2951,'invoice'),(1409,718,'invoice'),
      (5268,1911,'invoice'),(5945,2704,'invoice'),
      (6914,3433,'delivery_note'),(2903,2813,'delivery_note'),
      (4497,426,'delivery_note'),(42,3519,'delivery_note'),
      (4049,3448,'delivery_note'),(818,646,'delivery_note')
    ) targets(client_id,order_id,kind) order by client_id
  loop
    select * into strict c from public.clients where id=target.client_id for update;
    select * into strict o from public.orders where id=target.order_id for share;
    if o.client_id<>c.id or o.status::text<>'delivered' then
      raise exception 'Source order for client % changed; audit again.',c.id;
    end if;
    before_data:=to_jsonb(c);
    if target.kind='invoice' then
      data:=jsonb_build_object(
        'billing_company_name',nullif(btrim(o.extra_fields#>>'{documents,invoice_snapshot,company_name}'),''),
        'billing_tax_id',nullif(btrim(o.extra_fields#>>'{documents,invoice_snapshot,tax_id}'),''),
        'billing_address',nullif(btrim(o.extra_fields#>>'{documents,invoice_snapshot,address}'),''),
        'billing_phone',nullif(btrim(o.extra_fields#>>'{documents,invoice_snapshot,phone}'),''));
    else
      data:=jsonb_build_object(
        'delivery_note_name',nullif(btrim(o.extra_fields#>>'{documents,delivery_note_snapshot,name}'),''),
        'delivery_note_document_id',nullif(btrim(o.extra_fields#>>'{documents,delivery_note_snapshot,document_id}'),''),
        'delivery_note_address',nullif(btrim(o.extra_fields#>>'{documents,delivery_note_snapshot,address}'),''),
        'delivery_note_phone',nullif(btrim(o.extra_fields#>>'{documents,delivery_note_snapshot,phone}'),''));
    end if;
    data:=jsonb_strip_nulls(data);
    if data='{}'::jsonb then raise exception 'Client % has no recoverable source values.',c.id; end if;
    field_count:=field_count+(select count(*) from jsonb_object_keys(data));

    -- Re-check every non-cancelled order, not only the chosen source snapshot.
    if exists(
      select 1 from public.orders h
      cross join lateral (select case when target.kind='invoice'
        then h.extra_fields#>'{documents,invoice_snapshot}'
        else h.extra_fields#>'{documents,delivery_note_snapshot}' end as snapshot) document
      cross join lateral jsonb_each_text(case when jsonb_typeof(document.snapshot)='object'
        then document.snapshot else '{}'::jsonb end) entry
      where h.client_id=c.id and h.status::text<>'cancelled'
        and nullif(btrim(entry.value),'') is not null
        and entry.key in ('company_name','tax_id','name','document_id','address','phone')
      group by entry.key having count(distinct case
        when entry.key in ('tax_id','document_id','phone')
          then regexp_replace(lower(entry.value),'[^[:alnum:]]','','g')
        else regexp_replace(lower(btrim(entry.value)),'\s+',' ','g') end)>1
    ) then raise exception 'Historical variants found for client %; no recovery applied.',c.id; end if;

    patch:='{}'::jsonb;
    for field in select * from jsonb_each_text(data) loop
      current_value:=nullif(btrim(before_data->>field.key),'');
      if current_value is null then
        patch:=patch||jsonb_build_object(field.key,field.value);
      elsif current_value is distinct from field.value then
        raise exception 'Client % now has different saved data; no overwrite allowed.',c.id;
      end if;
    end loop;
    if patch<>'{}'::jsonb then
      filled:=jsonb_populate_record(null::public.clients,before_data||patch);
      update public.clients set
        billing_company_name=filled.billing_company_name,billing_tax_id=filled.billing_tax_id,
        billing_address=filled.billing_address,billing_phone=filled.billing_phone,
        delivery_note_name=filled.delivery_note_name,delivery_note_document_id=filled.delivery_note_document_id,
        delivery_note_address=filled.delivery_note_address,delivery_note_phone=filled.delivery_note_phone
      where id=c.id;
    end if;
    if (select to_jsonb(x)-array['billing_company_name','billing_tax_id','billing_address','billing_phone',
      'delivery_note_name','delivery_note_document_id','delivery_note_address','delivery_note_phone','updated_at'] from public.clients x where id=c.id)
      is distinct from (before_data-array['billing_company_name','billing_tax_id','billing_address','billing_phone',
      'delivery_note_name','delivery_note_document_id','delivery_note_address','delivery_note_phone','updated_at'])
      or (select to_jsonb(x) from public.clients x where id=c.id) @> data is not true then
      raise exception 'Verification failed for client %; no recovery applied.',c.id;
    end if;
    seen:=seen+1;
  end loop;
  set constraints all immediate;
  if seen<>14 or field_count<>50 then raise exception 'Recovery evidence changed; expected 14 clients / 50 source fields.'; end if;
  if (select jsonb_agg(to_jsonb(x) order by id) from public.clients x where id in (2117,3718))
    is distinct from excluded_before then raise exception 'Excluded clients changed unexpectedly.'; end if;
end $repair$;

select 'Recovered source fields verified; no conflicting clients or historical orders modified' as result;
rollback;
