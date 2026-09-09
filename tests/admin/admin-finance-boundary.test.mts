import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relativePath: string) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

const migrationPath = 'supabase/migrations/20260909163806_admin_financial_overview_v1.sql';
const rpcNames = [
  'admin_finance_commercial_overview_v1',
  'admin_finance_treasury_overview_v1',
  'admin_finance_position_overview_v1',
];

function functionDefinition(sql: string, name: string) {
  const start = sql.indexOf(`create or replace function public.${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const next = sql.indexOf('create or replace function public.', start + 1);
  return sql.slice(start, next === -1 ? sql.length : next);
}

test('keeps every Admin finance RPC behind the same database authorization boundary', () => {
  const migration = read(migrationPath);

  for (const name of rpcNames) {
    const definition = functionDefinition(migration, name);
    assert.match(definition, /security definer/);
    assert.match(definition, /set search_path = ''/);
    assert.match(definition, /auth\.uid\(\)/);
    assert.match(definition, /role_row\.role = 'admin'/);
    assert.match(
      migration,
      new RegExp(
        `revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated, service_role;[\\s\\S]*?grant execute on function public\\.${name}\\([\\s\\S]*?to authenticated;`
      )
    );
  }

  assert.doesNotMatch(migration, /grant execute on function public\.admin_finance_[\s\S]*?to authenticated, service_role/);
});

test('blocks unknown treasury net values instead of silently treating them as zero', () => {
  const migration = read(migrationPath);

  assert.match(migration, /'netExternalCashFlowUsd', case[\s\S]*?unclassified_adjustment_count > 0[\s\S]*?then null/);
  assert.match(migration, /'netCashFlowQuality', case[\s\S]*?then 'Q4_blocked'/);
  assert.match(migration, /'unclassifiedAdjustmentUsd', current_summary\.unclassified_adjustment_usd/);
  assert.match(migration, /cash_count_adjustment/);
  assert.match(migration, /abs\(facts\.confirmed_source_usd - facts\.confirmed_target_usd\) > 0\.005/);
  assert.match(migration, /movement\.confirmed_at <= v_as_of/);
  assert.match(migration, /report\.reviewed_at is null or report\.reviewed_at > v_as_of/);
  assert.match(migration, /client_fund_post_cutoff/);
  assert.match(migration, /left join active_rate on true/);
  assert.doesNotMatch(migration, /'clientFundsQuality', 'Q1_exact'[\s\S]*?'activeAccounts', 0/);
});

test('keeps valid domains visible when a neighboring dashboard domain fails', () => {
  const dashboard = read('src/app/app/admin/_components/FinancialDashboard.tsx');

  assert.match(dashboard, /<DomainValue domain={overview\.commercial}>/);
  assert.match(dashboard, /<DomainValue domain={overview\.treasury}>/);
  assert.match(dashboard, /<DomainValue domain={overview\.position}>/);
  assert.doesNotMatch(dashboard, /commercial && treasury/);
  assert.doesNotMatch(dashboard, /treasury && position/);
});

test('preserves period, cutoff and definition when opening the detailed finance dashboard', () => {
  const dashboard = read('src/app/app/admin/_components/FinancialDashboard.tsx');
  const navigation = read('src/app/app/admin/_lib/navigation.ts');

  assert.match(dashboard, /snapshotQuery = `period=\$\{currentPeriod\.key\}&asOf=/);
  assert.match(dashboard, /&definition=\$\{overview\.definitionVersion\}/);
  assert.match(dashboard, /financialDetailPath = `\/app\/admin\/finanzas\?\$\{snapshotQuery\}`/);
  assert.match(dashboard, /#commercial-detail/);
  assert.match(dashboard, /#treasury-detail/);
  assert.match(dashboard, /#position-detail/);
  assert.match(navigation, /href: '\/app\/admin\/finanzas'/);
});
