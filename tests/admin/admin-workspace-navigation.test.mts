import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const { registerHooks } = await import('node:module');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === './return-navigation' && context.parentURL?.endsWith('/admin-workspace.ts')) return next('./return-navigation.ts', context);
  return next(specifier, context);
}});
const { adminWorkspaceHref, sharedWorkspacePath } = await import('../../src/lib/navigation/admin-workspace.ts');
test('maps every shared domain and keeps query, hash and short order links', () => {
  for (const [from,to] of [['/app/inventory/configure?view=create','#unused'],['/app/commissions/7?section=pagos','/app/admin/finanzas/comisiones/operar/7?section=pagos'],['/app/master/plays?play=24','/app/admin/jugadas?play=24'],['/app/events/7','/app/admin/eventos/7']] as const) {
    assert.equal(adminWorkspaceHref(from,'/app/admin'), from.startsWith('/app/inventory') ? '/app/admin/inventario/configure?view=create' : to);
  }
  assert.equal(adminWorkspaceHref('/app/master/ops?openOrder=2934&tab=pagos','/app/admin'),'/app/admin/ordenes?openOrder=2934&tab=pagos');
  assert.equal(adminWorkspaceHref('/app/master/ops/finance?status=pending','/app/admin'),'/app/admin/finanzas/pagos?status=pending');
  assert.equal(adminWorkspaceHref('/app/master/ops/finance?status=pending','/app/master/ops'),'/app/master/ops/finance?status=pending');
  assert.equal(sharedWorkspacePath('/app/admin/inventario/counts/7'),'/app/inventory/counts/7');
});
test('does not redirect other roles, unknown routes, or external links', () => {
  for(const source of ['/app/master/ops','/app/advisor','/app/admin-impostor','https://external.test/app/admin']) {
    assert.equal(adminWorkspaceHref('/app/inventory',source),'/app/inventory');
  }
  for(const href of ['//outside.test/app/inventory','https://outside.test/app/inventory','/app/inventory-old','/app/master/dashboard?adminSection=accounts']) assert.equal(adminWorkspaceHref(href,'/app/admin'),href);
});
test('workspace metadata cannot supply authorization or be spoofed by clients', () => {
  const read=(path:string)=>readFileSync(new URL('../../'+path,import.meta.url),'utf8');
  assert.match(read('src/proxy.ts'),/requestHeaders.set\('x-vivo-workspace-path', req.nextUrl.pathname\)/);
  assert.doesNotMatch(read('src/lib/auth.ts'),/x-vivo-workspace/);
  for(const path of ['inventario','jugadas','eventos','finanzas/comisiones/operar']) {
    const page=read('src/app/app/admin/'+path+'/[[...section]]/page.tsx');
    assert.match(page,/await requireAdminContext\(\)/);
    assert.match(page,/notFound\(\)/);
    assert.match(page,/consultar/);
  }
});
