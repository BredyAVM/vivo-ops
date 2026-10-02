import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import {
  paymentReportFilters,
  paymentReportWindow,
  paymentReportsHref,
} from "../../src/lib/admin-finance/payment-reports-model.ts";
const calls: { table: string; method: string; args: unknown[] }[] = [];
let allowed = true,
  records: unknown[] = [],
  error: unknown = null;
const supabase = {
  from(table: string) {
    calls.push({ table, method: "from", args: [] });
    const q: Record<string, unknown> = {};
    for (const method of ["select", "or", "eq", "in", "order", "range"])
      q[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return q;
      };
    q.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: table === "payment_reports" ? records : [],
        error,
      }).then(resolve);
    return q;
  },
};
Reflect.set(globalThis, "__paymentReports", {
  context: () => {
    if (!allowed) throw new Error("No autorizado");
    return { supabase };
  },
});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only")
      return { url: "data:text/javascript,export{}", shortCircuit: true };
    if (specifier === "@/lib/auth")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export async function requireAdminContext(){return globalThis.__paymentReports.context()}",
          ),
        shortCircuit: true,
      };
    if (specifier === "./payment-reports-model")
      return next("./payment-reports-model.ts", context);
    return next(specifier, context);
  },
});
const { loadAdminPaymentReports } =
  await import("../../src/lib/admin-finance/payment-reports-data.ts");
const now = new Date("2026-10-02T02:00:00Z");
test("date defaults and legacy fallback use Caracas, inclusive operation dates", () => {
  const f = paymentReportFilters({}, now);
  assert.equal(f.to, "2026-10-01");
  assert.equal(f.from, "2026-09-25");
  assert.deepEqual(paymentReportWindow(f), {
    start: "2026-09-25T04:00:00.000Z",
    end: "2026-10-02T04:00:00.000Z",
  });
  assert.match(paymentReportsHref({ ...f, orderId: 2934 }, 2), /order=2934/);
  for (const p of [
    { from: "2026-02-30" },
    { to: "2026-13-01" },
    { order: "1.2" },
    { page: "0" },
    { status: "voided" },
    { from: "2024-01-01" },
  ])
    assert.throws(() => paymentReportFilters(p, now));
});
test("cold payment entry makes no business read; role rejection comes first", async () => {
  calls.length = 0;
  allowed = true;
  assert.equal((await loadAdminPaymentReports({}, now)).queried, false);
  assert.equal(calls.length, 0);
  allowed = false;
  await assert.rejects(
    loadAdminPaymentReports({ consultar: "1" }, now),
    /No autorizado/,
  );
  assert.equal(calls.length, 0);
  allowed = true;
});
test("payment query is scoped before stable 25 plus sentinel pagination", async () => {
  calls.length = 0;
  records = Array.from({ length: 26 }, (_, i) => ({
    id: i + 1,
    order_id: 2934,
    status: "confirmed",
    created_at: "2026-09-08T12:00:00Z",
    reported_currency_code: "USD",
    reported_amount: "20",
    created_by_user_id: null,
  }));
  const result = await loadAdminPaymentReports(
    {
      consultar: "1",
      from: "2026-09-07",
      to: "2026-09-13",
      status: "confirmed",
      order: "2934",
      page: "2",
    },
    now,
  );
  assert.equal(result.rows.length, 25);
  assert.equal(result.hasMore, true);
  assert.deepEqual(calls.find((c) => c.method === "range")?.args, [25, 50]);
  assert.ok(
    calls.some(
      (c) =>
        c.method === "eq" && c.args[0] === "order_id" && c.args[1] === 2934,
    ),
  );
  assert.match(
    String(calls.find((c) => c.method === "or")?.args[0]),
    /operation_date.is.null.*created_at.gte.2026-09-07T04:00/,
  );
  assert.equal(calls.filter((c) => c.method === "from").length, 1);
  assert.ok(!calls.some((c) => c.table === "money_movements"));
});
test("read errors and invalid report amounts never become success with empty results", async () => {
  error = { message: "offline" };
  await assert.rejects(
    loadAdminPaymentReports({ consultar: "1" }, now),
    /No se pudieron/,
  );
  error = null;
  for (const amount of ["NaN", null, "", -1]) {
    records = [
      {
        id: 1,
        order_id: 2934,
        status: "pending",
        created_at: "2026-09-08T12:00:00Z",
        reported_currency_code: "USD",
        reported_amount: amount,
      },
    ];
    await assert.rejects(
      loadAdminPaymentReports({ consultar: "1" }, now),
      /incompletos/,
    );
  }
  const page = readFileSync(
    "src/app/app/admin/finanzas/pagos/page.tsx",
    "utf8",
  );
  assert.match(page, /openOrder=\$\{row.order_id\}&tab=pagos/);
  assert.doesNotMatch(page, /order_number|movementGroupId/);
});
