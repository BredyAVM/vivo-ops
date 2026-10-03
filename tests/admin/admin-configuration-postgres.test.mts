import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

// Real PostgreSQL/PLpgSQL in an isolated in-memory database; no production access.
test("native configuration executes atomically with scoped privileges and exact replay", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      readFileSync("tests/fixtures/admin-configuration-schema.sql", "utf8"),
    );
    await db.exec(
      readFileSync(
        "supabase/migrations/20261003171627_admin_configuration_atomic.sql",
        "utf8",
      ),
    );
    const admin = "00000000-0000-4000-8000-000000000001",
      advisor = "00000000-0000-4000-8000-000000000002";
    await db.exec(
      `insert into auth.users values ('${admin}'),('${advisor}'); insert into public.profiles(id,full_name) values ('${admin}','Test Admin'),('${advisor}','Test Advisor'); insert into public.user_roles(user_id,role) values ('${admin}','admin'),('${advisor}','advisor');`,
    );
    const auth = async (id: string, role = "authenticated") => {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
        id,
      ]);
      await db.exec(`set role ${role}`);
    };
    const count = async (table: string) => {
      await db.exec("reset role");
      return Number(
        (
          await db.query<{ n: number }>(
            `select count(*)::int as n from ${table}`,
          )
        ).rows[0].n,
      );
    };
    await auth("", "anon");
    await assert.rejects(
      () => db.query("select public.admin_configuration_capabilities_v1()"),
      /permission denied/,
    );
    await auth(advisor);
    await assert.rejects(
      () => db.query("select public.admin_configuration_capabilities_v1()"),
      /administrador activo/,
    );
    await assert.rejects(
      () =>
        db.query("select public.admin_account_configuration_v1($1,$2)", [
          {},
          admin,
        ]),
      /administrador activo/,
    );
    await auth(admin);
    assert.deepEqual(
      (
        await db.query<{ v: unknown }>(
          "select public.admin_configuration_capabilities_v1() as v",
        )
      ).rows[0].v,
      { version: "admin-configuration-v1", atomic: true },
    );
    const op = "00000000-0000-4000-8000-000000000011";
    const input = {
      name: "Test Bank",
      currencyCode: "VES",
      accountKind: "bank",
      isActive: true,
    };
    const created = await db.query<{ v: { account: { id: number } } }>(
      "select public.admin_account_configuration_v1($1,$2) as v",
      [input, op],
    );
    const id = created.rows[0].v.account.id;
    assert.deepEqual(
      (
        await db.query(
          "select public.admin_account_configuration_v1($1,$2) as v",
          [input, op],
        )
      ).rows,
      created.rows,
    );
    await assert.rejects(
      () =>
        db.query("select public.admin_account_configuration_v1($1,$2)", [
          { ...input, name: "Changed" },
          op,
        ]),
      /otros datos/,
    );
    assert.equal(await count("public.money_accounts"), 1);
    await auth(admin);
    await assert.rejects(
      () =>
        db.query("select public.admin_account_configuration_v1($1,$2)", [
          { ...input, accountId: id, currencyCode: "USD" },
          advisor,
        ]),
      /Se conserva/,
    );
    // Failure after account INSERT must also roll back that account, not just its profile.
    await db.exec("reset role");
    await db.exec(
      "create function app_private.test_fail_profile() returns trigger language plpgsql as $f$ begin raise exception 'Synthetic final failure'; end $f$; create trigger test_fail_profile before insert on public.money_account_closure_profiles for each row execute function app_private.test_fail_profile();",
    );
    await auth(admin);
    await assert.rejects(
      () =>
        db.query("select public.admin_account_configuration_v1($1,$2)", [
          { ...input, name: "Rollback only" },
          "00000000-0000-4000-8000-000000000012",
        ]),
      /Synthetic final failure/,
    );
    assert.equal(await count("public.money_accounts"), 1);
    assert.equal(await count("app_private.admin_configuration_audit"), 1);
    await db.exec(
      "drop trigger test_fail_profile on public.money_account_closure_profiles",
    );
    await auth(admin);
    const rules = [
      {
        role: "admin",
        payment_method_code: "payment_mobile",
        can_confirm_payment: true,
        review_required: false,
        review_roles: [],
        is_active: true,
      },
    ];
    await db.query("select public.admin_account_rules_v1($1,$2,$3)", [
      id,
      rules,
      "00000000-0000-4000-8000-000000000013",
    ]);
    await assert.rejects(
      () =>
        db.query("select public.admin_account_rules_v1($1,$2,$3)", [
          id,
          [
            {
              ...rules[0],
              auto_confirms_report: true,
              can_confirm_payment: false,
            },
          ],
          "00000000-0000-4000-8000-000000000014",
        ]),
      /check constraint/,
    );
    await db.exec("reset role");
    assert.equal(
      (
        await db.query<{ v: boolean }>(
          "select can_confirm_payment as v from public.money_account_payment_rules where money_account_id=$1",
          [id],
        )
      ).rows[0].v,
      true,
    );
    await auth(admin);
    await assert.rejects(
      () =>
        db.query("select public.admin_user_configuration_v1($1)", [
          {
            userId: admin,
            fullName: "Test Admin",
            roles: ["advisor"],
            isActive: true,
          },
        ]),
      /propio acceso/,
    );
    await db.query("select public.admin_user_configuration_v1($1)", [
      {
        userId: advisor,
        fullName: "Test Advisor Updated",
        roles: ["driver"],
        isActive: true,
        receivesCommissions: false,
      },
    ]);
    await db.exec("reset role");
    assert.deepEqual(
      (
        await db.query<{ role: string }>(
          "select role::text as role from public.user_roles where user_id=$1",
          [advisor],
        )
      ).rows.map((r) => r.role),
      ["driver"],
    );
    await db.exec(
      `insert into public.money_movements values (${id},'inflow',100,1,'confirmed','2026-09-30'),(${id},'outflow',20,0.2,'confirmed','2026-09-30'),(${id},'inflow',50,0.5,'pending','2026-09-30');`,
    );
    await auth(admin);
    const baseline = {
      moneyAccountId: id,
      baselineDate: "2026-09-30",
      countedAmount: 80,
      exchangeRateVesPerUsd: 100,
    };
    const base = (
      await db.query<{
        v: { expected_amount: number; difference_amount: number };
      }>("select public.admin_account_baseline_v1($1,$2) as v", [
        baseline,
        "00000000-0000-4000-8000-000000000015",
      ])
    ).rows[0].v;
    assert.equal(Number(base.expected_amount), 80);
    assert.equal(Number(base.difference_amount), 0);
    await assert.rejects(
      () =>
        db.query("select public.admin_account_baseline_v1($1,$2)", [
          baseline,
          "00000000-0000-4000-8000-000000000016",
        ]),
      /línea base activa/,
    );
    await assert.rejects(
      () => db.query("select * from app_private.admin_configuration_audit"),
      /permission denied/,
    );
    const history = (
      await db.query<{ v: unknown[] }>(
        "select public.admin_configuration_history_v1() as v",
      )
    ).rows[0].v;
    assert.equal(history.length, 4);
    assert.ok(
      history.every(
        (v) => !("request_payload" in (v as Record<string, unknown>)),
      ),
    );
    await db.exec("reset role");
    await db.query("update public.profiles set is_active=false where id=$1", [
      admin,
    ]);
    await auth(admin);
    await assert.rejects(
      () => db.query("select public.admin_configuration_capabilities_v1()"),
      /administrador activo/,
    );
  } finally {
    await db.close();
  }
});
