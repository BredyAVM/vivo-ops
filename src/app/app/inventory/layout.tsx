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

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <header className="border-b border-[#242433] bg-[#101014]">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-5 py-5 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">
              Vivo Ops
            </div>
            <h1 className="mt-1 text-2xl font-semibold">Centro de Inventario</h1>
            <p className="mt-1 text-sm text-[#A6A6B2]">
              Centro de verdad para catálogo, disponibilidad y trazabilidad.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/app/inventory"
              prefetch={false}
              className="rounded-xl border border-[#FEEF00]/60 bg-[#181812] px-3 py-2 text-sm font-semibold text-[#FEEF00]"
            >
              Ítems
            </Link>
            <Link
              href="/app/inventory/products"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Productos
            </Link>
            {ctx.roles.includes('admin') ? (
              <Link
                href="/app/inventory/configure"
                prefetch={false}
                className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
              >
                Configurar
              </Link>
            ) : null}
            <Link
              href="/app/inventory/opening"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Apertura
            </Link>
            <Link
              href="/app/inventory/recipes"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Recetas
            </Link>
            <Link
              href="/app/inventory/counts"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Conteos históricos
            </Link>
            <Link
              href="/app/inventory/operations"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Operaciones
            </Link>
            <Link
              href="/app/inventory/incidents"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] hover:border-[#FEEF00]/50"
            >
              Incidencias
            </Link>
            <Link
              href="/app/master/dashboard"
              prefetch={false}
              className="rounded-xl border border-[#2A2A39] px-3 py-2 text-sm text-[#A6A6B2] hover:text-white"
            >
              Volver a la dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 py-6">{children}</main>
    </div>
  );
}
