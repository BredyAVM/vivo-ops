import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  filterAdminFinanceAccounts,
  normalizeAdminFinanceAccountSection,
  normalizeAdminFinanceAccountsFilters,
  normalizeAdminFinanceDetailStatus,
  type AdminFinanceAccountSnapshot,
} from '../../src/lib/admin-finance/accounts-model.ts';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relativePath: string) {
  return readFileSync(join(repositoryRoot, relativePath), 'utf8');
}

function account(
  id: number,
  overrides: Partial<AdminFinanceAccountSnapshot> = {}
): AdminFinanceAccountSnapshot {
  return {
    id,
    name: `Cuenta ${id}`,
    currencyCode: 'USD',
    accountKind: 'bank',
    workstream: 'bank',
    institutionName: null,
    ownerName: null,
    isActive: true,
    closureKind: 'bank',
    baselineRequired: true,
    balanceNative: id * 100,
    ledgerValueUsd: id * 100,
    currentValueUsd: id * 100,
    anchorKind: 'closure',
    anchorDate: '2026-09-09',
    anchorAt: '2026-09-09T12:00:00.000Z',
    anchorAmount: id * 100,
    latestClosureId: id,
    latestClosureDate: '2026-09-09',
    latestClosureAt: '2026-09-09T12:00:00.000Z',
    latestClosureStatus: 'recorded',
    latestClosureDifference: 0,
    latestClosureDifferenceUsd: 0,
    openReconciliations: 0,
    openReconciliationNative: 0,
    openReconciliationUsd: 0,
    orphanedReconciliations: 0,
    pendingMovementOperations: 0,
    pendingMovementNative: 0,
    pendingMovementUsd: 0,
    quality: 'Q1_exact',
    ...overrides,
  };
}

test('defaults the account center to active accounts needing attention first', () => {
  const filters = normalizeAdminFinanceAccountsFilters({});
  const result = filterAdminFinanceAccounts(
    [
      account(1),
      account(2, { openReconciliations: 2 }),
      account(3, { isActive: false, openReconciliations: 5 }),
    ],
    filters
  );

  assert.equal(filters.state, 'active');
  assert.equal(filters.sort, 'attention');
  assert.deepEqual(result.accounts.map((row) => row.id), [2, 1]);
});

test('supports operational deep links without confusing them with active state', () => {
  const filters = normalizeAdminFinanceAccountsFilters({
    state: 'orphaned_reconciliation',
    estado: 'all',
  });
  const result = filterAdminFinanceAccounts(
    [
      account(1, { orphanedReconciliations: 1 }),
      account(2, { openReconciliations: 3 }),
      account(3, { isActive: false, orphanedReconciliations: 2 }),
    ],
    filters
  );

  assert.equal(filters.attention, 'orphaned_reconciliation');
  assert.equal(filters.state, 'all');
  assert.deepEqual(result.accounts.map((row) => row.id), [1, 3]);
});

test('accepts only statuses that belong to the selected account tab', () => {
  assert.equal(normalizeAdminFinanceDetailStatus('movements', 'pending'), 'pending');
  assert.equal(normalizeAdminFinanceDetailStatus('movements', 'open'), 'all');
  assert.equal(normalizeAdminFinanceDetailStatus('closures', 'approved'), 'approved');
  assert.equal(normalizeAdminFinanceDetailStatus('closures', 'pending'), 'all');
  assert.equal(normalizeAdminFinanceDetailStatus('reconciliation', 'open'), 'open');
  assert.equal(normalizeAdminFinanceDetailStatus('reconciliation', 'recorded'), 'all');
  assert.equal(normalizeAdminFinanceDetailStatus('configuration', 'resolved'), 'all');

  const section = normalizeAdminFinanceAccountSection('closures');
  assert.equal(normalizeAdminFinanceDetailStatus(section, 'recorded'), 'recorded');
});

test('keeps the account RPCs admin-only and the private calculator uncallable', () => {
  const migration = read('supabase/migrations/20260909185117_admin_finance_accounts_read_v1.sql');

  for (const name of ['admin_finance_accounts_overview_v1', 'admin_finance_account_detail_v1']) {
    const start = migration.indexOf(`create or replace function public.${name}`);
    assert.notEqual(start, -1, `missing ${name}`);
    const definition = migration.slice(start, migration.indexOf('$function$;', start) + '$function$;'.length);
    assert.match(definition, /security definer/);
    assert.match(definition, /set search_path = ''/);
    assert.match(definition, /auth\.uid\(\)/);
    assert.match(definition, /role_row\.role = 'admin'/);
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([\\s\\S]*?from public, anon, authenticated, service_role;`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}\\([\\s\\S]*?to authenticated;`));
  }

  assert.match(
    migration,
    /revoke all on function app_private\.admin_finance_account_snapshots_v1\(timestamptz\)[\s\S]*?from public, anon, authenticated, service_role;/
  );
  assert.doesNotMatch(migration, /service_role_key|SUPABASE_SERVICE_ROLE_KEY/);
});

test('preserves the audited balance rules in the database calculator', () => {
  const migration = read('supabase/migrations/20260909185117_admin_finance_accounts_read_v1.sql');

  assert.match(migration, /closure\.status in \('recorded', 'approved'\)/);
  assert.match(migration, /baseline\.status = 'active'/);
  assert.match(migration, /movement\.status = 'confirmed'/);
  assert.match(migration, /movement\.movement_date <= input\.local_date/);
  assert.match(migration, /account\.account_kind = 'pos' or account\.closure_kind = 'pos' then 0::numeric/);
  assert.match(migration, /movement\.reference_code ~ '\^closure-\[0-9\]\+\$'/);
  assert.doesNotMatch(migration, /'treasuryPositionUsd'/);
});

test('replaces the unsafe historical cutoff with a strict current v2 contract', () => {
  const migration = read(
    'supabase/migrations/20260909193734_admin_finance_accounts_current_cutoff_v2.sql'
  );

  assert.match(migration, /create function public\.admin_finance_accounts_overview_v2\(\s*p_include_inactive boolean default false\s*\)/);
  assert.match(migration, /create function public\.admin_finance_account_detail_v2\([\s\S]*?p_offset integer default 0\s*\)/);
  assert.doesNotMatch(migration, /create function public\.admin_finance_accounts_overview_v1/);
  assert.doesNotMatch(migration, /create function public\.admin_finance_account_detail_v1/);
  assert.match(migration, /v_as_of timestamptz := pg_catalog\.statement_timestamp\(\)/g);
  assert.match(migration, /'definitionVersion', 'admin-finance-accounts-v2'/g);
  assert.match(migration, /'cutoffMode', 'current_statement'/g);
  assert.match(migration, /revoke all on function app_private\.admin_finance_accounts_overview_legacy_v1[\s\S]*?from public, anon, authenticated, service_role;/);
  assert.match(migration, /revoke all on function app_private\.admin_finance_account_detail_legacy_v1[\s\S]*?from public, anon, authenticated, service_role;/);
});

test('uses the canonical post-anchor timestamp rule and reports rate integrity', () => {
  const migration = read(
    'supabase/migrations/20260909193734_admin_finance_accounts_current_cutoff_v2.sql'
  );

  assert.match(migration, /movement\.movement_date <= cutoff\.local_date/);
  assert.match(
    migration,
    /coalesce\(movement\.confirmed_at, movement\.created_at\) > snapshot\.anchor_at/
  );
  assert.doesNotMatch(migration, /uses_daily_cutoff/);
  assert.doesNotMatch(migration, /movement\.movement_date > snapshot\.anchor_date/);
  assert.match(migration, /rate\.is_active = true/);
  assert.match(migration, /'activeRateCount'/);
  assert.match(migration, /'rateQuality'/);
  assert.match(migration, /'single_active_at_current_statement'/);
});

test('publishes native-total coverage and validates statuses per detail section', () => {
  const migration = read(
    'supabase/migrations/20260909193734_admin_finance_accounts_current_cutoff_v2.sql'
  );

  for (const key of [
    'nativeUsdCoveredTotal',
    'nativeUsdUncoveredTotal',
    'nativeUsdCoveredAccounts',
    'nativeUsdTotalAccounts',
    'nativeUsdCoveragePct',
    'nativeUsdQuality',
    'nativeUsdQ1Accounts',
    'nativeUsdQ3Accounts',
    'nativeUsdQ4Accounts',
    'nativeVesCoveredTotal',
    'nativeVesUncoveredTotal',
    'nativeVesCoveredAccounts',
    'nativeVesTotalAccounts',
    'nativeVesCoveragePct',
    'nativeVesQuality',
    'nativeVesQ1Accounts',
    'nativeVesQ3Accounts',
    'nativeVesQ4Accounts',
  ]) {
    assert.match(migration, new RegExp(`'${key}'`), `missing ${key}`);
  }

  assert.match(migration, /v_section = 'movements'[\s\S]*?v_status not in \('all', 'pending', 'confirmed', 'rejected', 'voided'\)/);
  assert.match(migration, /v_section = 'closures'[\s\S]*?v_status not in \('all', 'recorded', 'approved', 'rejected'\)/);
  assert.match(migration, /v_section = 'reconciliation'[\s\S]*?v_status not in \('all', 'open', 'resolved', 'voided'\)/);
  assert.match(migration, /v_section = 'configuration'[\s\S]*?v_status <> 'all'/);
});

test('orders the canonical anchor and latest closure by event timestamp, never business date', () => {
  const migration = read(
    'supabase/migrations/20260909200436_admin_finance_accounts_canonical_anchor_order_v3.sql'
  );
  const functionStart = migration.indexOf(
    'create or replace function app_private.admin_finance_account_snapshots_v2('
  );
  const functionEnd = migration.indexOf('$function$;', functionStart) + '$function$;'.length;
  const definition = migration.slice(functionStart, functionEnd);

  assert.notEqual(functionStart, -1);
  assert.match(definition, /security definer/);
  assert.match(definition, /set search_path = ''/);
  assert.equal(
    (migration.match(/create or replace function/g) ?? []).length,
    1,
    'the correction must replace only the private snapshot calculator'
  );
  assert.doesNotMatch(migration, /create or replace function public\./);

  const canonicalClosureOrder = /order by\s+coalesce\(closure\.closure_at, closure\.created_at\) desc,\s+closure\.created_at desc,\s+closure\.id desc/g;
  assert.equal(
    (definition.match(canonicalClosureOrder) ?? []).length,
    2,
    'the valid anchor and latest closure must share the timestamp-first order'
  );
  assert.doesNotMatch(definition, /closure\.closure_date desc/);
  assert.doesNotMatch(definition, /closure\.closure_date <= cutoff\.local_date/);
  assert.match(
    definition,
    /order by baseline\.baseline_at desc, baseline\.id desc[\s\S]*?valid_baseline on valid_closure\.id is null/
  );

  assert.match(definition, /movement\.movement_date <= cutoff\.local_date/);
  assert.match(
    definition,
    /coalesce\(movement\.confirmed_at, movement\.created_at\) > account\.anchor_at/
  );
  assert.doesNotMatch(definition, /movement\.movement_date > account\.anchor_date/);
  assert.match(definition, /movement\.reference_code ~ '\^closure-\[0-9\]\+\$'/);
  assert.match(definition, /rate_state\.active_rate_count = 1/);
  assert.match(definition, /rate_state\.active_rate_count <> 1 then 'Q4_blocked'/);
  assert.match(definition, /item\.resolved_at is null or item\.resolved_at > cutoff\.as_of/);
  assert.match(definition, /movement\.confirmed_at is null or movement\.confirmed_at > cutoff\.as_of/);

  assert.match(
    migration,
    /revoke all on function app_private\.admin_finance_account_snapshots_v2\(timestamptz\)[\s\S]*?from public, anon, authenticated, service_role;/
  );
  assert.doesNotMatch(migration, /grant execute/);
});
