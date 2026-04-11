'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

type AdvisorShellProps = {
  children: ReactNode;
  email: string;
  fullName: string;
};

const navItems = [
  { href: '/app/advisor', label: 'Inicio' },
  { href: '/app/advisor/orders', label: 'Pedidos' },
  { href: '/app/advisor/payments', label: 'Pagos' },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AdvisorShell(props: AdvisorShellProps) {
  const { children } = props;
  const pathname = usePathname();
  const isNewOrderRoute = pathname.startsWith('/app/advisor/new');

  return (
    <div className="min-h-screen bg-[#090B10] text-[#F5F7FB]">
      <div className="mx-auto flex min-h-screen max-w-screen-md flex-col pb-10">
        <header className="sticky top-0 z-20 border-b border-[#1A1D26] bg-[#090B10]/92 px-4 pb-3 pt-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-[#8B93A7]">VIVO OPS</p>
              <h1 className="mt-1 truncate text-[20px] font-semibold tracking-[-0.04em]">Asesor</h1>
            </div>
            {!isNewOrderRoute ? (
              <Link
                href="/app/advisor/new"
                className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-3.5 text-sm font-semibold text-[#17191E]"
              >
                Nuevo pedido
              </Link>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            {navItems.map((item) => {
              const active = isActive(pathname, item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={[
                    'flex h-10 items-center justify-center rounded-[14px] text-sm font-medium transition',
                    active ? 'bg-[#161A24] text-[#F5F7FB]' : 'border border-[#232632] text-[#8B93A7]',
                  ].join(' ')}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </header>

        <main className="flex-1 px-4 py-4">{children}</main>
      </div>
    </div>
  );
}
