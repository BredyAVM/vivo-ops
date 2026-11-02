// Test-only renderer. No credentials, production requests or persisted test routes.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { createServer } = require('node:http');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '../../..');
const externalRequire = createRequire(path.join(root, 'package.json'));

async function renderAdvisorPage(detail = 'payable', scenario = 'released') {
  const recorded = { orderId: 2478, orderNumber: '2478', clientName: 'Cliente de prueba',
    deliveryDate: '2026-10-16', totalUsd: 116, billedUsd: 100, confirmedPaidUsd: 106,
    pendingUsd: 10, commissionUsd: 5, commissionMode: 'fixed_order', paymentTiming: 'pending' };
  const live = { closureId: 323, supported: true, checkedAt: '2026-11-02T14:00:00Z',
    agreedPayableUsd: 0, paidUsd: 0, customerDebtUsd: 0, carriedCommissionUsd: 0,
    priorAdvisorDebtUsd: 0, creditUsd: 18.88, payableUsd: 18.88, pendingUsd: 18.88,
    retainedUsd: 0, remainingCreditUsd: 18.88, advisorDebtUsd: 0, overpaidUsd: 0,
    orders: [{ ...recorded, billedUsd: 116, confirmedPaidUsd: 116, pendingUsd: 0, paymentStatus: 'paid' }],
    transferredToClosureId: null, transferredCreditUsd: null, transferredAt: null, incomingTransferCount: 0 };
  if (scenario === 'partial') Object.assign(live, { paidUsd: 10, pendingUsd: 8.88 });
  if (scenario === 'transferred') Object.assign(live, { transferredToClosureId: 400,
    transferredCreditUsd: 18.88, payableUsd: 0, pendingUsd: 0, remainingCreditUsd: 0 });
  const closure = { id: 323, status: 'paid', base_commission_pct: 8, delivered_orders_count: 1,
    billed_usd: 100, gross_commission_usd: 18.88, regular_base_usd: 0, special_item_base_usd: 0,
    special_order_base_usd: 100, pending_collection_usd: 18.88, punctual_paid_count: 0,
    late_paid_count: 0, pending_payment_count: 1, new_own_clients_count: 0, new_assigned_clients_count: 0,
    gift_deductions_usd: 0, manual_deductions_usd: 0, payable_usd: 0,
    generated_at: '2026-10-17T14:00:00Z', closed_at: '2026-10-20T14:00:00Z', paid_at: '2026-10-20T14:00:00Z',
    deductions: [], snapshot: { orders: [recorded], pending_orders: [recorded],
      settlement: { formulaVersion: 'advisor-settlement-v1', retainedCommissionUsd: 18.88 } } };
  const before = JSON.stringify({ closure, live });
  const reads = [];
  const supabase = {
    from(table) {
      const query = { table, filters: [] };
      reads.push(query);
      const builder = {
        select() { return builder; },
        eq(key, value) { query.filters.push([key, value]); return builder; },
        order() { return builder; },
        async limit() {
          if (table !== 'advisor_commission_periods') throw new Error('Unexpected query');
          return { data: [{ id: 10, name: 'Octubre 02', date_from: '2026-10-16', date_to: '2026-10-31', status: 'open' }], error: null };
        },
        async maybeSingle() {
          if (table === 'profiles') return { data: { receives_commissions: true }, error: null };
          if (table === 'advisor_commission_closures') {
            if (!query.filters.some(([key, value]) => key === 'advisor_user_id' && value === 'fixture-advisor')) throw new Error('Missing advisor ownership filter');
            return { data: closure, error: null };
          }
          throw new Error('Unexpected query');
        },
      };
      return builder;
    },
    async rpc(name, args) {
      reads.push({ name, args });
      if (name !== 'advisor_commission_collections_v1' || JSON.stringify(args.p_closure_ids) !== '[323]') throw new Error('Unexpected RPC');
      return scenario === 'error' ? { data: null, error: { message: 'Sin conexión de prueba' } } : { data: [live], error: null };
    },
  };
  const cache = new Map();
  const mocks = {
    '@/lib/auth': { getAuthContext: async () => ({ user: { id: 'fixture-advisor' }, supabase }) },
    '@/lib/commissions/goal-data': {},
    'next/link': { __esModule: true, default: ({ children, ...props }) => React.createElement('a', props, children) },
    'next/navigation': { useRouter: () => ({ refresh() {} }), redirect: (url) => { throw new Error(`Redirect ${url}`); } },
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: filename,
    }).outputText;
    const localRequire = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (!id.startsWith('.') && !id.startsWith('@/')) return externalRequire(id);
      const base = id.startsWith('@/') ? path.join(root, 'src', id.slice(2)) : path.resolve(path.dirname(filename), id);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')].find((file) => fs.existsSync(file) && fs.statSync(file).isFile());
      if (!resolved) throw new Error(`Unresolved ${id}`);
      return load(resolved);
    };
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  const Page = load(path.join(root, 'src/app/app/advisor/commissions/page.tsx')).default;
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ period: '10', detail }) }));
  if (JSON.stringify({ closure, live }) !== before) throw new Error('Rendering mutated the agreement or live data');
  return { html, reads };
}
module.exports = { renderAdvisorPage };

if (require.main === module) {
  createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1:3217');
      if (url.pathname === '/styles.css') {
        const folder = path.join(root, '.next/static/css');
        res.setHeader('Content-Type', 'text/css');
        res.end(fs.readdirSync(folder).filter((name) => name.endsWith('.css')).map((name) => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n'));
        return;
      }
      const { html } = await renderAdvisorPage(url.searchParams.get('detail') || 'payable', url.searchParams.get('scenario') || 'released');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><title>Verificación local · comisiones</title></head><body style="background:#080a10;color:#f5f7fb;font-family:Arial,sans-serif"><main style="width:100%;max-width:420px;margin:auto;padding:16px"><p style="font-size:11px;color:#aaa">VERIFICACIÓN LOCAL · DATOS FICTICIOS</p>${html}</main></body></html>`);
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  }).listen(3217, '127.0.0.1', () => console.log('Test-only UI: http://127.0.0.1:3217/?detail=payable'));
}
