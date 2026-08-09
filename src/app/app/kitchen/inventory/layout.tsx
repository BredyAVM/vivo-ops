import type { ReactNode } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getAuthContext, resolveHomePath } from '@/lib/auth';
import { ModulePreference } from '../../ModulePreference';

export default async function KitchenInventoryLayout({ children }: { children: ReactNode }) {
  const ctx = await getAuthContext();
  if (!ctx) redirect('/login');

  const canOperate = ctx.roles.includes('admin') || ctx.roles.includes('kitchen');
  if (!canOperate) redirect(resolveHomePath(ctx.roles));

  return (
    <main className="kitchen-app min-h-screen bg-[#08090D] text-[#F5F5F7]">
      <ModulePreference moduleKey="kitchen" />
      <header className="kitchen-safe-header border-b border-[#242433] bg-[#0D0D12]">
        <div className="mx-auto max-w-[1180px] px-4 pb-4 sm:px-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-[#FEEF00]">
                VIVO OPS · Cocina
              </div>
              <h1 className="mt-1 text-2xl font-black">Inventario operativo</h1>
              <p className="mt-1 max-w-2xl text-sm leading-6 text-[#A6A6B2]">
                Entradas, preparaciones, conteos ciegos y salidas de calidad sobre el mismo saldo canónico.
              </p>
            </div>
            <Link
              href="/app/kitchen"
              prefetch={false}
              className="inline-flex h-11 items-center justify-center rounded-xl border border-[#343442] bg-[#15151D] px-4 text-sm font-semibold"
            >
              Volver a pedidos
            </Link>
          </div>

          <nav className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <InventoryNavLink href="/app/kitchen/inventory">Guía</InventoryNavLink>
            <InventoryNavLink href="/app/kitchen/inventory/receipts">Entradas</InventoryNavLink>
            <InventoryNavLink href="/app/kitchen/inventory/production">Preparación</InventoryNavLink>
            <InventoryNavLink href="/app/kitchen/inventory/counts">Conteos</InventoryNavLink>
            <InventoryNavLink href="/app/kitchen/inventory/losses">Calidad</InventoryNavLink>
          </nav>
        </div>
      </header>
      <div className="kitchen-safe-content mx-auto max-w-[1180px] px-4 py-5 sm:px-6">{children}</div>
    </main>
  );
}

function InventoryNavLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      className="flex min-h-11 items-center justify-center rounded-xl border border-[#30303F] bg-[#15151D] px-3 text-center text-sm font-semibold text-[#E6E6EC] hover:border-[#FEEF00]/60 hover:text-[#FEEF00]"
    >
      {children}
    </Link>
  );
}
