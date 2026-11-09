import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
function loadTs(filename: string, formStatus: { pending: boolean; data: FormData | null } = { pending: false, data: null }) {
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  new Function('require', 'module', 'exports', code)(
    (id: string) => id === 'react-dom' ? { useFormStatus: () => formStatus }
      : id.startsWith('.') ? loadTs([`${id}.ts`, `${id}.tsx`].map((file) => resolve(dirname(filename), file)).find(existsSync)!, formStatus) : require(id), module, module.exports,
  );
  return module.exports;
}
const component = (file: string, status?: { pending: boolean; data: FormData | null }) =>
  loadTs(join(root, 'src/app/app/commissions/goals', file), status).default as React.ComponentType<Record<string, unknown>>;
const actions = (status?: { pending: boolean; data: FormData | null }, props = {}) =>
  renderToStaticMarkup(React.createElement(component('GoalConfigurationActions.tsx', status), props));
const feedback = (props = {}) => renderToStaticMarkup(React.createElement(component('GoalActionFeedback.tsx'), props));

test('first publication preserves both intents and starts enabled with no fabricated success', () => {
  const html = actions();
  assert.match(html, />Publicar meta</);
  assert.match(html, /<button(?=[^>]*name="intent")(?=[^>]*value="draft")[^>]*>/);
  assert.match(html, /<button(?=[^>]*name="intent")(?=[^>]*value="publish")[^>]*>/);
  assert.doesNotMatch(html, /disabled=""|Última publicación|Operación completada/);
});

test('publishing shows a spinner and live progress and disables both submit buttons', () => {
  const data = new FormData(); data.set('intent', 'publish');
  const html = actions({ pending: true, data });
  assert.match(html, /Publicando metas…/);
  assert.match(html, /animate-spin/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /no necesitas pulsar de nuevo/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Guardando borrador…|Operación completada/);
});

test('saving a draft never claims to publish and restores normal controls after completion', () => {
  const data = new FormData(); data.set('intent', 'draft');
  const html = actions({ pending: true, data });
  assert.match(html, /Guardando borrador…/);
  assert.match(html, /todavía no se publica/);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.doesNotMatch(html, /Publicando metas…/);
  assert.doesNotMatch(actions(), /disabled=""/);
});

test('confirmed publication persists as Caracas time and clearly labels a subsequent update', () => {
  const html = actions(undefined, { publishedAt: '2026-11-09T13:36:49.924Z' });
  assert.match(html, /Última publicación:/);
  assert.match(html, /09:36/);
  assert.match(html, /visible para los asesores/);
  assert.match(html, />Actualizar publicación</);
  assert.match(html, /debes actualizar la publicación/);
  assert.doesNotMatch(actions(undefined, { publishedAt: 'invalid' }), /Última publicación|Invalid Date/);
});

test('success and errors remain visible in the viewport, accessible and explicitly dismissible', () => {
  const success = feedback({ notice: 'Metas publicadas con trazabilidad por asesor.', periodName: 'Noviembre 01' });
  assert.match(success, /role="status"/);
  assert.match(success, /fixed inset-x-4 bottom-24/);
  assert.match(success, /Metas publicadas/);
  assert.match(success, /Noviembre 01/);
  assert.match(success, /aria-label="Cerrar aviso"/);
  const error = feedback({ notice: 'success must not win', error: 'Debes indicar el motivo.' });
  assert.match(error, /role="alert"/);
  assert.match(error, /No se pudo completar la operación/);
  assert.match(error, /Debes indicar el motivo/);
  assert.match(error, /Revisa el estado actual/);
  assert.doesNotMatch(error, /Operación completada|success must not win/);
  assert.equal(feedback(), '');
});

test('feedback is safely escaped, never rendered as HTML', () => {
  assert.match(feedback({ error: '<img src=x onerror=alert(1)>' }), /&lt;img/);
  assert.doesNotMatch(feedback({ error: '<img src=x onerror=alert(1)>' }), /<img/);
});

test('same repeated failure can re-open feedback and redirects stay inside Administration', () => {
  const { adminWorkspaceHref } = loadTs(join(root, 'src/lib/navigation/admin-workspace.ts')) as { adminWorkspaceHref: (destination: string, current: string) => string };
  const source = readFileSync(join(root, 'src/app/app/commissions/goals/actions.ts'), 'utf8');
  const save = source.slice(source.indexOf('export async function saveAdvisorGoalConfigurationAction'));
  assert.equal((save.match(/&feedback=\$\{Date.now\(\)\}/g) ?? []).length, 2);
  assert.match(save, /await requireGoalAdmin\(\)/);
  assert.match(save, /save_advisor_goal_publications_v1/);
  assert.match(save, /await applyAdvisorCommissionGoalResults/);
  const page = readFileSync(join(root, 'src/app/app/commissions/goals/page.tsx'), 'utf8');
  const controls = readFileSync(join(root, 'src/app/app/commissions/goals/GoalConfigurationActions.tsx'), 'utf8');
  assert.match(controls, /<GoalActionFeedback key=\{`\$\{feedbackKey/);
  assert.match(page, /feedbackKey=\{params.feedback\}/);
  assert.match(page, /<WorkspaceForm action=\{saveAdvisorGoalConfigurationAction\}/);
  assert.match(page, /<GoalConfigurationActions publishedAt=/);
  assert.equal(adminWorkspaceHref('/app/commissions/goals?period=11&feedback=1&notice=Publicado',
    '/app/admin/finanzas/comisiones/operar/goals'), '/app/admin/finanzas/comisiones/operar/goals?period=11&feedback=1&notice=Publicado');
});

test('a new attempt hides the previous success instead of showing it during a pending publication', () => {
  const data = new FormData(); data.set('intent', 'publish');
  const html = actions({ pending: true, data }, { notice: 'Metas publicadas previamente.' });
  assert.match(html, /Publicando metas…/);
  assert.doesNotMatch(html, /Operación completada|Metas publicadas previamente/);
});

test('new client components cannot publish, calculate, notify or access financial data themselves', () => {
  for (const file of ['GoalConfigurationActions.tsx', 'GoalActionFeedback.tsx']) {
    const source = readFileSync(join(root, 'src/app/app/commissions/goals', file), 'utf8');
    assert.doesNotMatch(source, /supabase|fetch\(|\.rpc\(|notifyAdvisor|generateAdvisorCommission|router\.push|router\.replace|dangerouslySetInnerHTML/);
  }
});
