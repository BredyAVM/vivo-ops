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

export default function AdvisorShell({ children, email, fullName }: AdvisorShellProps) {
  const pathname = usePathname();

  return (
    <div className="min-h-screen bg-[#090B10] text-[#F5F7FB]">
      <div className="mx-auto flex min-h-screen max-w-screen-md flex-col pb-28">
        <header className="sticky top-0 z-20 border-b border-[#1A1D26] bg-[#090B10]/92 px-4 pb-3 pt-4 backdrop-blur">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-[#8B93A7]">VIVO OPS</p>
              <h1 className="mt-1 truncate text-[22px] font-semibold tracking-[-0.04em]">Asesor</h1>
            </div>
            <div className="max-w-[12rem] rounded-[18px] border border-[#232632] bg-[#12151d] px-3 py-2 text-right">
              <div className="truncate text-sm font-medium text-[#F5F7FB]">{fullName}</div>
              <div className="truncate text-[11px] text-[#8B93A7]">{email}</div>
            </div>
          </div>
        </header>

        <main className="flex-1 px-4 py-4">{children}</main>
      </div>

      <Link
        href="/app/advisor/new"
        className="fixed bottom-[86px] right-4 z-30 inline-flex h-12 items-center rounded-full bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E] shadow-[0_18px_32px_rgba(240,208,0,0.22)]"
      >
        Nuevo pedido
      </Link>

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-[#1A1D26] bg-[#0C0E14]/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto grid max-w-screen-md grid-cols-3 gap-2">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href);

            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'flex h-11 items-center justify-center rounded-[16px] text-sm font-medium transition',
                  active ? 'bg-[#161A24] text-[#F5F7FB]' : 'text-[#8B93A7]',
                ].join(' ')}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
