import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole } from '@/lib/auth';

export default async function InventoryLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();

  if (!ctx) {
    redirect('/login');
  }

  if (!isMasterOrAdminRole(ctx.roles)) {
    redirect('/app');
  }

  const returnHref = ctx.roles.includes('admin') ? '/app/master/dashboard' : '/app/master/ops';
  const returnLabel = ctx.roles.includes('admin') ? 'Volver a la dashboard' : 'Volver a Máster';

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <header className="border-b border-[#242433] bg-[#101014]">
        <div className="mx-auto max-w-[1500px] px-5 py-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">
              Vivo Ops
            </div>
            <h1 className="mt-1 text-2xl font-semibold">Centro de Inventario</h1>
            <p className="mt-1 text-sm text-[#A6A6B2]">
              Centro de verdad para existencias, reglas, disponibilidad y trazabilidad.
            </p>
          </div>

            <div className="flex flex-wrap items-start gap-4">
              <NavGroup label="Operar">
                <NavLink href="/app/inventory" primary>Existencias</NavLink>
                <NavLink href="/app/inventory/operations">Operaciones</NavLink>
                <NavLink href="/app/inventory/recipes">Producción</NavLink>
                <NavLink href="/app/inventory/counts">Conteos</NavLink>
              </NavGroup>
              <NavGroup label="Analizar">
                <NavLink href="/app/inventory/products">Productos</NavLink>
                <NavLink href="/app/inventory/reports">Reportes</NavLink>
                <NavLink href="/app/inventory/alerts">Alertas</NavLink>
              </NavGroup>
              {ctx.roles.includes('admin') ? (
                <NavGroup label="Administrar">
                  <NavLink href="/app/inventory/configure">Reglas y catálogo</NavLink>
                  <NavLink href="/app/inventory/readiness">Auditoría</NavLink>
                </NavGroup>
              ) : null}
            </div>
          </div>

          <div className="mt-4 flex justify-end">
            <Link
              href={returnHref}
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] px-3 py-2 text-sm text-[#A6A6B2] hover:text-white"
            >
              {returnLabel}
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 py-6">{children}</main>
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-[#777785]">
        {label}
      </div>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function NavLink({ href, primary = false, children }: {
  href: string;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      prefetch={false}
      className={primary
        ? 'rounded-xl border border-[#FEEF00]/60 bg-[#181812] px-3 py-2 text-sm font-semibold text-[#FEEF00]'
        : 'rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50'}
    >
      {children}
    </Link>
  );
}
