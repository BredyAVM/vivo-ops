import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Independent native PostgreSQL sessions, never a production connection.
// Run with CONFIGURATION_PSQL and CONFIGURATION_PG_PORT against a dedicated
// loopback cluster whose data directory is named vivo-config-pg-<random>.
const executable = process.env.CONFIGURATION_PSQL;
const port = process.env.CONFIGURATION_PG_PORT;
const enabled = Boolean(executable && port);
const admin = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const master = '00000000-0000-4000-8000-000000000003';
const q = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => q(JSON.stringify(value)) + '::jsonb';
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')));
Object.assign(environment, { PGHOST: '127.0.0.1', PGPORT: port, PGUSER: 'postgres', PGOPTIONS: '' });

class Session {
  constructor(database, name) {
    this.output = ''; this.errors = ''; this.pending = null; this.closed = false;
    this.child = spawn(executable, ['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', '-d', database],
      { env: { ...environment, PGAPPNAME: name }, windowsHide: true });
    this.child.stdout.on('data', data => {
      this.output += data.toString();
      if (this.pending && this.output.includes(this.pending.marker)) {
        const pending = this.pending; this.pending = null; clearTimeout(pending.timer);
        pending.resolve(this.output.split(pending.marker)[0].trim()); this.output = '';
      }
    });
    this.child.stderr.on('data', data => { this.errors += data.toString(); });
    this.child.on('error', error => this.fail(error));
    this.child.on('close', code => {
      this.closed = true;
      if (this.pending) this.fail(new Error(this.errors || `psql closed (${code})`));
    });
  }
  fail(error) {
    if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
  }
  sql(sql) {
    assert.equal(this.pending, null, 'A session executes only one command at a time');
    if (this.closed) return Promise.reject(new Error('Session closed'));
    const marker = 'done_' + randomUUID().replaceAll('-', '');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error('SQL timeout')); this.child.kill(); }, 15000);
      this.pending = { marker, resolve, reject, timer };
      this.child.stdin.write(sql + '\n\\echo ' + marker + '\n');
    });
  }
  async auth(id) {
    await this.sql(`select set_config('request.jwt.claim.sub',${q(id)},false); set role authenticated;`);
  }
  close() { this.child.stdin.end(); if (!this.closed) this.child.kill(); }
}

test('independent sessions serialize retries, rules, baselines and revoked administrators',
  { skip: !enabled, timeout: 90000 }, async t => {
    assert.match(port, /^\d{4,5}$/);
    const dataDir = execFileSync(executable, ['-XqAtw', '-d', 'postgres', '-c', 'show data_directory'],
      { env: environment, encoding: 'utf8', windowsHide: true }).trim();
    assert.match(dataDir.replaceAll('\\', '/'), /\/vivo-config-pg-[a-f0-9]+$/,
      'Refuse an existing or production cluster; only a dedicated synthetic cluster is allowed');
    const database = 'vivo_config_test_' + randomUUID().replaceAll('-', '');
    execFileSync(executable, ['-XqAtw', '-d', 'postgres', '-c', `create database ${database}`],
      { env: environment, windowsHide: true });
    const sessions = [];
    const connect = name => { const s = new Session(database, name); sessions.push(s); return s; };
    const owner = connect('configuration_test_observer');
    const account = { name: 'Synthetic cash', currencyCode: 'USD', accountKind: 'cash',
      institutionName: '', ownerName: '', notes: '', isActive: true };
    const callAccount = (input, operation) => `select public.admin_account_configuration_v1(${json(input)},${q(operation)});`;
    const callUser = (id, roles = ['advisor'], isActive = true) =>
      `select public.admin_user_configuration_v1(${json({ userId: id, fullName: 'Synthetic user', isActive, receivesCommissions: false, roles })});`;
    const restore = () => owner.sql(`update public.profiles set is_active=true where id in (${q(admin)},${q(other)});
      insert into public.user_roles(user_id,role) values (${q(admin)},'admin'),(${q(other)},'admin') on conflict do nothing;`);
    const blocked = async name => {
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        const result = await owner.sql(`select exists(select 1 from pg_stat_activity
          where application_name=${q(name)} and wait_event_type='Lock');`);
        if (result === 't') return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`Expected lock wait for ${name}`);
    };
    try {
      const fixture = readFileSync('tests/fixtures/admin-configuration-schema.sql', 'utf8')
        .replace(/create role (anon|authenticated|service_role);/g, (_, role) =>
          `do $role$ begin if not exists(select 1 from pg_roles where rolname='${role}') then create role ${role}; end if; end $role$;`);
      await owner.sql(fixture);
      await owner.sql(readFileSync('supabase/migrations/20261003171627_admin_configuration_atomic.sql', 'utf8'));
      await owner.sql(`insert into auth.users values (${q(admin)}),(${q(other)}),(${q(master)});
        insert into public.profiles(id,full_name) values (${q(admin)},'Admin A'),(${q(other)},'Admin B'),(${q(master)},'Master');
        insert into public.user_roles(user_id,role) values (${q(admin)},'admin'),(${q(other)},'admin'),(${q(master)},'master');`);
      const first = connect('configuration_first'); await first.auth(admin);
      let accountId;

      await t.test('simultaneous replay creates one account and one audit row', async () => {
        const operation = randomUUID(), second = connect('configuration_retry'); await second.auth(admin);
        await first.sql('begin;'); const result = await first.sql(callAccount(account, operation));
        const pending = second.sql(callAccount(account, operation)); await blocked('configuration_retry');
        await first.sql('commit;'); assert.deepEqual(JSON.parse(await pending), JSON.parse(result));
        accountId = JSON.parse(result).account.id;
        assert.equal(await owner.sql(`select count(*) from app_private.admin_configuration_audit where operation_id=${q(operation)};`), '1');
        second.close();
      });

      await t.test('conflicting retry is rejected after the first transaction commits', async () => {
        const operation = randomUUID(), second = connect('configuration_conflict'); await second.auth(admin);
        await first.sql('begin;'); await first.sql(callAccount({ ...account, accountId, name: 'Saved original' }, operation));
        const rejection = assert.rejects(second.sql(callAccount({ ...account, accountId, name: 'Do not save' }, operation)), /otros datos/);
        await blocked('configuration_conflict'); await first.sql('commit;'); await rejection;
        assert.equal(await owner.sql(`select name from public.money_accounts where id=${accountId};`), 'Saved original');
      });

      await t.test('different rules commands preserve serial previous/next audit values', async () => {
        const second = connect('configuration_rules'); await second.auth(admin);
        const rules = active => [{ role: 'admin', payment_method_code: 'cash_usd', can_view_account: true,
          can_confirm_payment: true, auto_confirms_report: true, review_required: false, review_roles: [], is_active: active }];
        const one = randomUUID(), two = randomUUID();
        await first.sql('begin;'); const saved = await first.sql(`select public.admin_account_rules_v1(${accountId},${json(rules(true))},${q(one)});`);
        const pending = second.sql(`select public.admin_account_rules_v1(${accountId},${json(rules(false))},${q(two)});`);
        await blocked('configuration_rules'); await first.sql('commit;'); await pending;
        assert.deepEqual(JSON.parse(await owner.sql(`select previous_value from app_private.admin_configuration_audit where operation_id=${q(two)};`)), JSON.parse(saved));
        second.close();
      });

      await t.test('activation waiting on an edit preserves the edited name and closure profile', async () => {
        const second = connect('configuration_activation'); await second.auth(admin);
        await first.sql('begin;');
        await first.sql(callAccount({ ...account, accountId, name: 'Concurrent edited name' }, randomUUID()));
        const pending = second.sql(callAccount({ accountId, activeOnly: true, isActive: false }, randomUUID()));
        await blocked('configuration_activation'); await first.sql('commit;');
        const saved = JSON.parse(await pending);
        assert.equal(saved.account.name, 'Concurrent edited name'); assert.equal(saved.account.is_active, false);
        assert.equal(saved.closureProfile.closure_kind, 'cash');
        second.close();
      });

      for (const isolation of ['repeatable read', 'serializable']) {
        await t.test(`persistent snapshots cannot bypass refreshed role authorization (${isolation})`, async () => {
          const second = connect('configuration_snapshot'); await second.auth(admin);
          await second.sql(`begin isolation level ${isolation}; select public.admin_configuration_capabilities_v1();`);
          await assert.rejects(second.sql(callAccount({ ...account, name: 'Persistent snapshot write' }, randomUUID())), /nueva transacci/);
          assert.equal(await owner.sql("select count(*) from public.money_accounts where name='Persistent snapshot write';"), '0');
        });
      }

      await t.test('concurrent baselines do not create two active opening balances', async () => {
        const second = connect('configuration_baseline'); await second.auth(admin);
        const input = { moneyAccountId: accountId, baselineDate: '2026-09-30', countedAmount: 0,
          exchangeRateVesPerUsd: null, reason: 'Synthetic baseline', notes: '' };
        await first.sql('begin;'); await first.sql(`select public.admin_account_baseline_v1(${json(input)},${q(randomUUID())});`);
        const rejection = assert.rejects(second.sql(`select public.admin_account_baseline_v1(${json(input)},${q(randomUUID())});`), /base activa/);
        await blocked('configuration_baseline'); await first.sql('commit;'); await rejection;
        assert.equal(await owner.sql(`select count(*) from public.money_account_closure_baselines where money_account_id=${accountId} and status='active';`), '1');
      });

      for (const inactive of [false, true]) {
        await t.test(`revoked administrator cannot write after waiting (inactive=${inactive})`, async () => {
          await restore(); const second = connect('configuration_revoked'); await second.auth(other);
          await first.sql('begin;'); await first.sql(callUser(other, inactive ? ['admin'] : ['advisor'], !inactive));
          const rejected = assert.rejects(second.sql(callAccount({ ...account, name: 'Must not exist' }, randomUUID())), /administrador activo/);
          await blocked('configuration_revoked'); await first.sql('commit;'); await rejected;
          assert.equal(await owner.sql("select count(*) from public.money_accounts where name='Must not exist';"), '0');
        });
      }

      await t.test('administrators cannot concurrently remove each other and leave no administrator', async () => {
        await restore(); const second = connect('configuration_cross_revoke'); await second.auth(other);
        await first.sql('begin;'); await first.sql(callUser(other));
        const rejected = assert.rejects(second.sql(callUser(admin)), /administrador activo/);
        await blocked('configuration_cross_revoke'); await first.sql('commit;'); await rejected;
        assert.equal(await owner.sql(`select count(*) from public.user_roles where user_id=${q(admin)} and role='admin';`), '1');
      });

      await t.test('Master retains the existing baseline permission, not user/account configuration', async () => {
        const session = connect('configuration_master'); await session.auth(master);
        const created = JSON.parse(await first.sql(callAccount({ ...account, name: 'Master baseline only' }, randomUUID())));
        const baseline = { moneyAccountId: created.account.id, baselineDate: '2026-09-30', countedAmount: 0 };
        const result = JSON.parse(await session.sql(`select public.admin_account_baseline_v1(${json(baseline)},${q(randomUUID())});`));
        assert.equal(result.created_by_user_id, master);
        await assert.rejects(session.sql(callAccount({ ...account, name: 'Forbidden Master' }, randomUUID())), /administrador activo/);
      });
    } finally {
      for (const session of sessions) session.close();
      // Retain the isolated database only inside the temporary test cluster.
      // The caller stops that cluster after the verification; no user database is dropped.
    }
  });
