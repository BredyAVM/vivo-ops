import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const adminRoot = join(repositoryRoot, 'src', 'app', 'app', 'admin');

function read(relativePath: string) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  });
}

test('protects the Admin V2 route with an explicit admin-only boundary', () => {
  const layout = read('src/app/app/admin/layout.tsx');

  assert.match(layout, /getAuthContext\(\)/);
  assert.match(layout, /if \(!ctx\)[\s\S]*redirect\('\/login'\)/);
  assert.match(layout, /if \(!isAdminRole\(ctx\.roles\)\)[\s\S]*redirect\(resolveHomePath\(ctx\.roles\)\)/);
});

test('keeps Admin V2 independent from legacy dashboard actions and business queries', () => {
  const source = collectFiles(adminRoot)
    .filter((filePath) => /\.(ts|tsx)$/.test(filePath))
    .map((filePath) => readFileSync(filePath, 'utf8'))
    .join('\n');

  assert.doesNotMatch(source, /master\/dashboard\/actions/);
  assert.doesNotMatch(source, /\bsupabase\s*\.\s*from\(/);
  assert.doesNotMatch(source, /\bsupabase\s*\.\s*rpc\(/);
  assert.doesNotMatch(source, /money_movements/);
});

test('leaves the production Admin entry pointing to the current dashboard', () => {
  const modules = read('src/lib/app-modules.ts');
  const adminDefinition = modules.match(/key: 'admin'[\s\S]*?href: '([^']+)'/);

  assert.equal(adminDefinition?.[1], '/app/master/dashboard');
});

test('does not prefetch the heavy operational centers from the new shell', () => {
  const navigation = read('src/app/app/admin/_lib/navigation.ts');
  const legacyLinks = navigation.match(/href: '\/app\/(?:master|inventory|commissions|events)[^']*'[\s\S]*?prefetch: (?:true|false)/g) ?? [];

  assert.ok(legacyLinks.length >= 5);
  for (const link of legacyLinks) {
    assert.match(link, /prefetch: false/);
  }
});

test('keeps the Admin home KPI-first and leaves the detailed dashboard on its own route', () => {
  const page = read('src/app/app/admin/page.tsx');
  const executiveDashboard = read('src/app/app/admin/_components/ExecutiveDashboard.tsx');
  const executiveData = read('src/lib/admin-finance/executive-data.ts');

  assert.match(page, /<ExecutiveDashboard/);
  assert.doesNotMatch(page, /<FinancialDashboard/);
  assert.doesNotMatch(executiveDashboard, /Radiografía financiera del negocio/);
  assert.match(executiveDashboard, /Facturado hoy/);
  assert.match(executiveDashboard, /Cierres hoy/);
  assert.match(executiveDashboard, /Cubierto hoy/);
  assert.match(executiveDashboard, /Por cobrar hoy/);
  assert.match(executiveData, /from\('order_events'\)/);
  assert.match(executiveData, /\.eq\('event', 'delivered'\)/);
  assert.match(executiveData, /get_orders_financial_state/);
});
