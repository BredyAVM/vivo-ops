import Link from 'next/link';
import FinancialDashboard from './_components/FinancialDashboard';
import { adminNavigation } from './_lib/navigation';
import { requireAdminContext } from '@/lib/auth';
import { loadAdminFinancialOverview, type AdminFinanceRpcClient } from '@/lib/admin-finance/data';
import { normalizeAdminFinancePeriod } from '@/lib/admin-finance/period';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AdminHomePage({ searchParams }: { searchParams?: SearchParams }) {
  const params = (await searchParams) ?? {};
  const periodKey = normalizeAdminFinancePeriod(firstParam(params.period));
  const ctx = await requireAdminContext();
  const overview = await loadAdminFinancialOverview({
    supabase: ctx.supabase as unknown as AdminFinanceRpcClient,
    periodKey,
  });
  const operationalCenters = adminNavigation.filter((item) =>
    ['orders', 'inventory', 'commissions', 'events', 'plays'].includes(item.key)
  );

  return (
    <div className="space-y-10">
      <FinancialDashboard overview={overview} basePath="/app/admin" />

      <section id="centros" className="scroll-mt-24">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#FEEF00]">Operación</p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">Centros de trabajo</h2>
          </div>
          <p className="max-w-xl text-sm leading-6 text-[#A1A1AD]">
            Cada centro carga su información únicamente cuando decides abrirlo.
          </p>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {operationalCenters.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              prefetch={false}
              className="group min-h-36 rounded-2xl border border-[#292937] bg-[#111117] p-5 transition hover:-translate-y-0.5 hover:border-[#FEEF00]/50 hover:bg-[#15151D] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00] motion-reduce:transform-none motion-reduce:transition-none"
            >
              <div className="flex items-start justify-between gap-4">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#363646] bg-[#1A1A23] text-xs font-black text-[#FEEF00]">
                  {item.marker}
                </span>
                <span className="rounded-full border border-[#343443] bg-[#17171F] px-2.5 py-1 text-xs font-semibold text-[#B8B8C2]">
                  Abrir
                </span>
              </div>
              <h3 className="mt-4 text-base font-semibold text-white group-hover:text-[#FEEF00]">{item.label}</h3>
              <p className="mt-1.5 text-sm leading-6 text-[#A1A1AD]">{item.description}</p>
            </Link>
          ))}
        </div>

        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-blue-400/20 bg-blue-400/5 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-6 text-blue-100/85">
            El panel anterior continúa disponible como respaldo mientras trasladamos cada acción con sus permisos y pruebas.
          </p>
          <Link
            href="/app/master/dashboard"
            prefetch={false}
            className="flex min-h-11 shrink-0 items-center justify-center rounded-xl border border-blue-300/30 px-4 text-sm font-semibold text-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-100"
          >
            Abrir panel anterior
          </Link>
        </div>
      </section>
    </div>
  );
}
