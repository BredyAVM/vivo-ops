'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { type ReactNode, useMemo, useState } from 'react';

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

function resolveHeaderTitle(pathname: string, isEditingOrder: boolean) {
  if (pathname.startsWith('/app/advisor/new')) {
    return isEditingOrder ? 'Modificar pedido' : 'Crear pedido';
  }
  if (pathname.startsWith('/app/advisor/orders/')) return 'Detalle del pedido';
  if (pathname.startsWith('/app/advisor/orders')) return 'Pedidos';
  if (pathname.startsWith('/app/advisor/payments')) return 'Pagos';
  if (pathname.startsWith('/app/advisor/inbox')) return 'Inbox';
  return 'Inicio';
}

function resolveBackHref(pathname: string) {
  if (pathname.startsWith('/app/advisor/new')) return '/app/advisor/orders';
  if (pathname.startsWith('/app/advisor/orders/')) return '/app/advisor/orders';
  if (pathname.startsWith('/app/advisor/inbox')) return '/app/advisor';
  return null;
}

export default function AdvisorShell(props: AdvisorShellProps) {
  const { children } = props;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [menuOpen, setMenuOpen] = useState(false);

  const isNewOrderRoute = pathname.startsWith('/app/advisor/new');
  const isEditingOrder = isNewOrderRoute && Number(searchParams.get('fromOrder') || 0) > 0;
  const headerTitle = resolveHeaderTitle(pathname, isEditingOrder);
  const backHref = resolveBackHref(pathname);

  const headerTag = useMemo(() => {
    if (pathname.startsWith('/app/advisor/new')) return 'Pedidos';
    if (pathname.startsWith('/app/advisor/orders/')) return 'Seguimiento';
    if (pathname.startsWith('/app/advisor/orders')) return 'Agenda';
    if (pathname.startsWith('/app/advisor/payments')) return 'Cobros';
    if (pathname.startsWith('/app/advisor/inbox')) return 'Alertas';
    return 'Asesor';
  }, [pathname]);

  return (
    <div className="advisor-app min-h-screen bg-[#090B10] text-[#F5F7FB]">
      <div className="mx-auto flex min-h-screen max-w-screen-md flex-col pb-10">
        <header className="sticky top-0 z-20 border-b border-[#171B24] bg-[#090B10]/92 px-4 py-2.5 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.24em] text-[#6F7890]">
                {headerTag}
              </div>
              <div className="truncate text-[15px] font-semibold text-[#F5F7FB]">
                {headerTitle}
              </div>
            </div>

            <div className="flex items-center gap-2">
              {!isNewOrderRoute ? (
                <Link
                  href="/app/advisor/new"
                  className="inline-flex h-9 items-center rounded-[12px] bg-[#F0D000] px-3 text-sm font-semibold text-[#17191E]"
                >
                  Nuevo
                </Link>
              ) : null}

              <button
                type="button"
                onClick={() => setMenuOpen((current) => !current)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[12px] border border-[#232632] bg-[#10131A] text-[#F5F7FB]"
                aria-label="Abrir menu"
                aria-expanded={menuOpen}
              >
                <span className="flex flex-col gap-1">
                  <span className="block h-[1.5px] w-4 rounded-full bg-current" />
                  <span className="block h-[1.5px] w-4 rounded-full bg-current" />
                  <span className="block h-[1.5px] w-4 rounded-full bg-current" />
                </span>
              </button>
            </div>
          </div>

          {menuOpen ? (
            <div className="absolute inset-x-4 top-full mt-2 rounded-[18px] border border-[#232632] bg-[#11141C] p-2 shadow-[0_16px_40px_rgba(0,0,0,0.35)]">
              <div className="grid gap-1">
                {navItems.map((item) => {
                  const active = isActive(pathname, item.href);

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setMenuOpen(false)}
                      className={[
                        'flex h-10 items-center rounded-[12px] px-3 text-sm font-medium transition',
                        active
                          ? 'bg-[#1A2030] text-[#F5F7FB]'
                          : 'text-[#AAB2C5] hover:bg-[#171B24] hover:text-[#F5F7FB]',
                      ].join(' ')}
                    >
                      {item.label}
                    </Link>
                  );
                })}

                {backHref ? (
                  <Link
                    href={backHref}
                    onClick={() => setMenuOpen(false)}
                    className="flex h-10 items-center rounded-[12px] px-3 text-sm font-medium text-[#AAB2C5] hover:bg-[#171B24] hover:text-[#F5F7FB]"
                  >
                    Volver
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
        </header>

        <main className="flex-1 px-4 py-4">{children}</main>
      </div>
    </div>
  );
}
