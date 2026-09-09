import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(
  new URL('../../supabase/migrations/20260908165750_secure_financial_rpc_boundary.sql', import.meta.url),
  'utf8',
);
const legacyBoundaryMigration = readFileSync(
  new URL(
    '../../supabase/migrations/20260908170727_harden_remaining_legacy_security_definers.sql',
    import.meta.url,
  ),
  'utf8',
);
const rejectPaymentReportMigration = readFileSync(
  new URL(
    '../../supabase/migrations/20260908171017_qualify_reject_payment_report_type.sql',
    import.meta.url,
  ),
  'utf8',
);
const dashboardAction = readFileSync(
  new URL('../../src/app/app/master/dashboard/actions.ts', import.meta.url),
  'utf8',
);

test('quarantines the privileged legacy financial functions', () => {
  assert.match(
    migration,
    /revoke all on function public\.confirm_payment_report_as_user\([\s\S]*?\) from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /revoke all on function public\.reject_payment_report_as_user\(uuid, bigint, text\)[\s\S]*?from public, anon, authenticated, service_role;/,
  );
  assert.match(
    migration,
    /drop function public\.set_active_exchange_rate\(numeric\);/,
  );
});

test('requires an authenticated Master or Admin to change the rate', () => {
  assert.match(migration, /v_uid uuid := \(select auth\.uid\(\)\);/);
  assert.match(migration, /if v_uid is null then/);
  assert.match(migration, /ur\.user_id = v_uid[\s\S]*?ur\.role in \('master', 'admin'\)/);
  assert.match(
    migration,
    /grant execute on function public\.set_active_exchange_rate\(numeric, uuid, text\)[\s\S]*?to authenticated;/,
  );
});

test('makes the daily rate change atomic, auditable and idempotent', () => {
  assert.match(migration, /lock table public\.exchange_rates in share row exclusive mode;/);
  assert.match(migration, /where er\.operation_id = v_operation_id;/);
  assert.match(migration, /previous_rate_id,[\s\S]*?previous_rate_bs_per_usd,[\s\S]*?change_reason,[\s\S]*?operation_id/);
  assert.match(migration, /update public\.products[\s\S]*?set source_price_amount = source_price_amount/);
  assert.match(dashboardAction, /await requireMasterOrAdmin\(\)/);
  assert.match(dashboardAction, /supabase\.rpc\('set_active_exchange_rate'/);
  assert.doesNotMatch(
    dashboardAction.match(/export async function updateExchangeRateAction[\s\S]*?\n}\n\nexport async function updateCatalogPricesQuickAction/)?.[0] ?? '',
    /\.from\('exchange_rates'\)/,
  );
});

test('limits batch financial state to operational roles and advisor ownership', () => {
  assert.match(migration, /public\.is_master_or_admin\(\)/);
  assert.match(migration, /public\.has_role\('counter'\)/);
  assert.match(
    migration,
    /public\.has_role\('advisor'\)[\s\S]*?order_row\.attributed_advisor_id = \(select auth\.uid\(\)\)/,
  );
  assert.match(
    migration,
    /revoke all on function public\.get_orders_financial_state\(bigint\[\], date, numeric\)[\s\S]*?from public, anon;/,
  );
});

test('removes anonymous access to authenticated profile directories', () => {
  assert.match(migration, /revoke all on function public\.get_advisor_profiles\(\)[\s\S]*?from public, anon;/);
  assert.match(migration, /revoke all on function public\.get_driver_profiles\(\)[\s\S]*?from public, anon;/);
});

test('closes the remaining anonymous legacy SECURITY DEFINER entry points', () => {
  for (const signature of [
    'admin_list_user_roles\\(\\)',
    'mark_order_modified\\(bigint, text\\)',
    'reject_payment_report\\(bigint, text\\)',
    'review_order_changes\\(bigint, boolean, text\\)',
  ]) {
    assert.match(
      legacyBoundaryMigration,
      new RegExp(`revoke all on function public\\.${signature}[\\s\\S]*?from public, anon, authenticated, service_role;`),
    );
  }

  assert.match(
    legacyBoundaryMigration,
    /alter function public\.reject_payment_report\(bigint, text\) set search_path = '';/,
  );
  assert.match(
    legacyBoundaryMigration,
    /grant execute on function public\.reject_payment_report\(bigint, text\)[\s\S]*?to authenticated, service_role;/,
  );
  assert.match(rejectPaymentReportMigration, /v_status public\.payment_report_status;/);
  assert.match(rejectPaymentReportMigration, /set search_path = ''/);
});
