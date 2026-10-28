import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';

const stub = 'data:text/javascript,' + encodeURIComponent(`
export const calls = [];
export let denied = false;
export let response = {data:null,error:null};
export function reset(){calls.length=0;denied=false;response={data:null,error:null};}
export function configure(value){response=value;}
export function deny(){denied=true;}
export async function requireAdminContext(){
  calls.push(['auth']);
  if(denied)throw new Error('No autorizado.');
  return {supabase:{rpc:async(name,args)=>{calls.push(['rpc',name,args]);return response;}}};
}
export function revalidatePath(path){calls.push(['refresh',path]);}
`);
type HookResult = { url: string; shortCircuit?: boolean };
const registerHooks = Reflect.get(nodeModule, 'registerHooks') as (hooks: {
  resolve(specifier: string, context: { parentURL?: string }, next: (specifier: string, context: { parentURL?: string }) => HookResult): HookResult;
}) => void;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@/lib/auth' || specifier === 'next/cache') return { url: stub, shortCircuit: true };
  if (specifier === 'server-only') return { url: 'data:text/javascript,export{}', shortCircuit: true };
  if (specifier === './model' && context.parentURL?.includes('/lib/brands/')) return next('./model.ts', context);
  return next(specifier, context);
} });
const control = await import(stub);
const { loadCommercialFoundation } = await import('../../src/lib/brands/data.ts');
const { saveBrandIncentiveDraft } = await import('../../src/lib/brands/actions.ts');

function form(first = '0,30', recurrent = '0.20') {
  const data = new FormData();
  data.set('firstOrderUsd', first); data.set('recurrentOrderUsd', recurrent);
  data.set('revision', '1'); data.set('operationId', '00000000-0000-4000-8000-000000000010');
  return data;
}
const previous = { ok: false, message: '' };

test('landing authenticates but does not query brands, catalogue, client history or financial data', async () => {
  control.reset();
  assert.equal(await loadCommercialFoundation({}), null);
  assert.deepEqual(control.calls, [['auth']]);
});
test('only an explicit consultation invokes the bounded read command with validated filters', async () => {
  control.reset();
  control.configure({ data: { invalid: true }, error: null });
  await assert.rejects(() => loadCommercialFoundation({ consultar: '1', catalogo: '1', marca: 'muerdeme', q: 'Burger', page: '2' }), /base de marcas/);
  assert.deepEqual(control.calls, [['auth'], ['rpc', 'admin_commercial_foundation_read_v1', {
    p_include_catalog: true, p_brand_code: 'muerdeme', p_query: 'Burger', p_page: 2,
  }]]);
});
test('invalid filter is rejected before a database call', async () => {
  control.reset();
  await assert.rejects(() => loadCommercialFoundation({ consultar: '1', marca: 'invented' }), /marca válida/);
  assert.deepEqual(control.calls, [['auth']]);
});
test('direct action invocation still requires an administrator', async () => {
  control.reset(); control.deny();
  assert.deepEqual(await saveBrandIncentiveDraft(previous, form()), { ok: false, message: 'No autorizado.' });
  assert.deepEqual(control.calls, [['auth']]);
});
test('USD form values save through their own draft policy command and refresh only the new route', async () => {
  control.reset(); control.configure({ data: { revision: 2, status: 'draft' }, error: null });
  assert.equal((await saveBrandIncentiveDraft(previous, form())).ok, true);
  assert.deepEqual(control.calls, [['auth'], ['rpc', 'admin_commercial_incentive_draft_save_v1', {
    p_first_order_usd: 0.3, p_recurrent_order_usd: 0.2, p_expected_revision: 1,
    p_operation_id: '00000000-0000-4000-8000-000000000010',
  }], ['refresh', '/app/admin/negocio/marcas']]);
});
test('malformed amounts and revisions never reach the database', async () => {
  for (const data of [form('0.295'), form('-1'), form(''), (() => { const f = form(); f.set('revision', '1.2'); return f; })()]) {
    control.reset();
    assert.equal((await saveBrandIncentiveDraft(previous, data)).ok, false);
    assert.deepEqual(control.calls, [['auth']]);
  }
});
test('concurrent edits and uncertain saves display an error without a false success or refresh', async () => {
  for (const response of [
    { data: null, error: { code: '40001' } },
    { data: null, error: { code: '42501' } },
    { data: null, error: { code: 'network' } },
    { data: null, error: null },
    { data: { status: 'active', revision: 2 }, error: null },
  ]) {
    control.reset(); control.configure(response);
    assert.equal((await saveBrandIncentiveDraft(previous, form())).ok, false);
    assert.equal(control.calls.some((call: string[]) => call[0] === 'refresh'), false);
  }
});
