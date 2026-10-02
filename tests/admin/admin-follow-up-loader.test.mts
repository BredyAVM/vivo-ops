import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';
const calls: string[] = [];
Reflect.set(globalThis, '__followUpCalls', calls);
const stub = (name: string, fn: string) => 'data:text/javascript,' + encodeURIComponent(`export async function ${fn}(){globalThis.__followUpCalls.push('${name}');return {status:'ready',data:{accounts:[],orders:[],rows:[],periods:[]}};}`);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === 'server-only') return {url:'data:text/javascript,export {};',shortCircuit:true};
  if (context.parentURL?.endsWith('/tasks-data.ts')) {
    const stubs: Record<string, string> = {
      './accounts-data':stub('cuentas','loadAdminFinanceAccountsOverview'),
      './active-orders-data':stub('pedidos','loadActiveOrdersOverview'),
      './commissions-data':stub('comisiones','loadCommissionsOverview'),
      './commissions-model':'data:text/javascript,export function selectCommissionPeriod(){return null;}',
      './period':'data:text/javascript,export function getCaracasDateKey(){return "2026-10-01";}',
      './tasks-model':'data:text/javascript,export function buildAdminTaskGroups(){return [];}',
    };
    if (stubs[specifier]) return {url:stubs[specifier],shortCircuit:true};
  }
  return nextResolve(specifier, context);
}});
const { loadAdminTasks } = await import('../../src/lib/admin-finance/tasks-data.ts');
test('follow-up queries only the selected domain, retaining all for old callers', async () => {
  for (const domain of ['cuentas','pedidos','comisiones','all'] as const) {
    calls.length = 0;
    await loadAdminTasks({rpc: async () => ({data:null,error:null})}, domain);
    assert.deepEqual(calls, domain === 'all' ? ['cuentas','pedidos','comisiones'] : [domain]);
  }
});
const read = (path: string) => readFileSync(new URL('../../'+path, import.meta.url),'utf8');
test('follow-up has an explicit query gate and never treats unavailable data as zero', () => {
  const source=read('src/app/app/admin/_components/AdminFollowUp.tsx');
  assert.match(source, /consultar/);
  assert.match(source, /first\('consultar'\) === '1' \? await loadAdminTasks/);
  assert.match(source, /No equivale a cero pendientes/);
});
test('follow-up does not fetch the approval queue and legacy links preserve filters', () => {
  const approvals=read('src/app/app/admin/autorizaciones/page.tsx');
  assert.ok(approvals.indexOf('if (followUp) return') < approvals.indexOf('await loadAuthorizations'));
  assert.match(approvals, /formatOrderDisplayLabel\(row.orderId\)/);
  const legacy=read('src/app/app/admin/tareas/page.tsx');
  assert.match(legacy, /bandeja.*seguimiento/);
  assert.match(legacy, /searchParams/);
});
