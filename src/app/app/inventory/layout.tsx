import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, isMasterOrAdminRole } from '@/lib/auth';
import InventoryNavigation from './InventoryNavigation';

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
  const isAdmin = ctx.roles.includes('admin');

  return (
    <div className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <header className="border-b border-[#242433] bg-[#101014]">
        <div className="mx-auto max-w-[1500px] px-5 py-5">
          <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">
                  Vivo Ops
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold">Inventario General</h1>
                  <span className="rounded-full border border-emerald-400/25 bg-emerald-400/5 px-2.5 py-1 text-[11px] font-semibold text-emerald-200">
                    Centro canónico
                  </span>
                </div>
                <p className="mt-1 text-sm text-[#A6A6B2]">
                  {isAdmin
                    ? 'Configura productos, controla existencias y atiende únicamente lo que requiere acción.'
                    : 'Consulta existencias y trazabilidad; las decisiones operativas de Máster vivirán en su módulo.'}
                </p>
              </div>
              <Link
                href={returnHref}
                prefetch={false}
                className="self-start rounded-xl border border-[#2A2A39] px-3 py-2 text-sm text-[#A6A6B2] hover:text-white"
              >
                {returnLabel}
              </Link>
            </div>

            <InventoryNavigation isAdmin={isAdmin} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-5 py-6">{children}</main>
    </div>
  );
}
