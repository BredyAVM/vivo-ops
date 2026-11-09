import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const dir = new URL('../../supabase/migrations/', import.meta.url);
const name = (await readdir(dir)).find(file => file.endsWith('_client_company_profiles.sql'));
const migration = await readFile(new URL(name, dir), 'utf8');
const uid = '00000000-0000-4000-8000-000000000001';
const secondId = '00000000-0000-4000-8000-000000000002';
const thirdId = '00000000-0000-4000-8000-000000000003';
await db.exec(`
  create role anon; create role authenticated; create schema auth; create schema app_private;
  create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
  create function public.has_role(text) returns boolean language sql as $$select coalesce(current_setting('test.role',true),'')=$1$$;
  create function public.is_master_or_admin() returns boolean language sql as $$select public.has_role('master') or public.has_role('admin')$$;
  grant usage on schema public,auth,app_private to authenticated;
  create table clients(id bigint primary key,billing_company_name text,billing_tax_id text,billing_address text,billing_phone text,
    delivery_note_name text,delivery_note_document_id text,delivery_note_address text,delivery_note_phone text);
  create table orders(id bigint primary key,extra_fields jsonb);
  insert into clients(id,billing_company_name,billing_tax_id,delivery_note_name) values (1,'Empresa original','J-123','Recibe original');
  insert into clients(id) values (2),(3);
  insert into orders values (1,'{"documents":{"invoice_snapshot":{"company_name":"Empresa histórica","tax_id":"J-OLD"}}}');
`);
await db.exec(migration).catch(error => { throw new Error(`Migration: ${error.message} (position ${error.position})`); });
await db.exec(`set role authenticated; select set_config('test.uid','${uid}',false),set_config('test.role','advisor',false);`);
const save = (id, version, label, data, isDefault = false, client = 1) => db.query(
  'select public.save_client_company_profile_v1($1,$2,$3,$4,$5::jsonb,$6) as profiles',
  [client,id,version,label,JSON.stringify(data),isDefault],
);
let originalId;

test('imports only existing saved data as one principal company; empty clients stay empty', async () => {
  const rows = (await db.query('select * from client_company_profiles order by client_id')).rows;
  assert.equal(rows.length, 1);
  originalId = rows[0].id;
  assert.equal(rows[0].label, 'Principal');
  assert.equal(rows[0].data.invoiceTaxId, 'J-123');
  assert.equal(rows[0].data.deliveryNoteName, 'Recibe original');
  assert.equal(rows[0].data.invoiceAddress, '');
});

test('creating another company does not overwrite principal, client fields or historical order', async () => {
  const result = await save(secondId,null,'Segunda empresa',{invoiceCompanyName:'Otra empresa',invoiceTaxId:'J-456'});
  assert.equal(result.rows[0].profiles.length,2);
  const original = result.rows[0].profiles.find(row => row.id === originalId);
  assert.equal(original.data.invoiceTaxId,'J-123');
  assert.equal(original.is_default,true);
  await db.exec('reset role');
  assert.equal((await db.query('select billing_tax_id from clients where id=1')).rows[0].billing_tax_id,'J-123');
  assert.equal((await db.query('select extra_fields from orders where id=1')).rows[0].extra_fields.documents.invoice_snapshot.tax_id,'J-OLD');
  await db.exec('set role authenticated');
});

test('retrying a successful creation is idempotent and conflicting aliases do not remove the default', async () => {
  await save(secondId,null,'Segunda empresa',{invoiceCompanyName:'Otra empresa',invoiceTaxId:'J-456'});
  assert.equal((await db.query('select count(*)::int as n from client_company_profiles')).rows[0].n,2);
  await assert.rejects(save(thirdId,null,' segunda EMPRESA ',{invoiceTaxId:'J-789'},true), error => error.code === '23505');
  assert.equal((await db.query('select id from client_company_profiles where is_default')).rows[0].id,originalId);
});

test('updates target only selected company, and switching principal is atomic', async () => {
  const result = await save(secondId,1,'Segunda empresa',{invoiceCompanyName:'Otra empresa editada',invoiceTaxId:'J-456'},true);
  assert.equal(result.rows[0].profiles.filter(row => row.is_default).length,1);
  assert.equal(result.rows[0].profiles.find(row => row.is_default).id,secondId);
  assert.equal(result.rows[0].profiles.find(row => row.id === originalId).data.invoiceTaxId,'J-123');
  await assert.rejects(save(secondId,1,'Cambio obsoleto',{invoiceTaxId:'J-INCORRECTO'}), error => error.code === '40001');
  await assert.rejects(save(secondId,null,'Segunda empresa',{invoiceTaxId:'J-INCORRECTO'}), error => error.code === '40001');
});

test('first company defaults automatically, IDs cannot cross clients, invalid payloads are rejected', async () => {
  await save(thirdId,null,'Primera',{deliveryNoteName:'Empresa B'},false,2);
  assert.equal((await db.query('select is_default from client_company_profiles where id=$1',[thirdId])).rows[0].is_default,true);
  await assert.rejects(save(thirdId,1,'Otra',{invoiceTaxId:'J-CROSS'},false,1), error => error.code === '42501');
  await assert.rejects(save(uid,null,'Vacía',{}), error => error.code === '22023');
  await assert.rejects(save(uid,null,'Maliciosa',{invoiceTaxId:'J-123',client_id:2}), error => error.code === '22023');
  await assert.rejects(save(uid,null,'Tipo incorrecto',{invoiceTaxId:123}), error => error.code === '22023');
});

test('RLS and bounded mutation deny unauthenticated, kitchen, driver and direct table writes', async () => {
  await assert.rejects(db.query("update client_company_profiles set label='Directo'"), error => error.code === '42501');
  await assert.rejects(db.query('delete from client_company_profiles'), error => error.code === '42501');
  for (const role of ['kitchen','driver','counter']) {
    await db.query("select set_config('test.role',$1,false)",[role]);
    assert.equal((await db.query('select * from client_company_profiles')).rows.length,0);
    await assert.rejects(save(uid,null,'Sin permiso',{invoiceTaxId:'J-123'}), error => error.code === '42501');
  }
  for (const role of ['master','admin']) {
    await db.query("select set_config('test.role',$1,false)",[role]);
    assert.equal((await db.query('select count(*)::int as n from client_company_profiles')).rows[0].n,3);
  }
  await db.exec("select set_config('test.uid','',false)");
  await assert.rejects(save(uid,null,'Sin sesión',{invoiceTaxId:'J-123'}), error => error.code === '42501');
  await db.exec('reset role; set role anon');
  await assert.rejects(save(uid,null,'Anónimo',{invoiceTaxId:'J-123'}), error => error.code === '42501');
  await assert.rejects(db.query('select * from client_company_profiles'), error => error.code === '42501');
});

test.after(() => db.close());
