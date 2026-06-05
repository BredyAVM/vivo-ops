'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useMemo, useState } from 'react';
import AdvisorInboxBell from './AdvisorInboxBell';
import AdvisorPendingLink from './AdvisorPendingLink';

type AdvisorShellProps = {
  children: ReactNode;
  fullName: string;
  userId: string;
  actionCount: number;
  updateCount: number;
};

const navItems = [
  { href: '/app/advisor', label: 'Inicio' },
  { href: '/app/advisor/orders', label: 'Pedidos' },
  { href: '/app/advisor/payments', label: 'Pagos' },
  { href: '/app/advisor/settings', label: 'Configuracion' },
];

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

function resolveBackHref(pathname: string) {
  if (pathname.startsWith('/app/advisor/new')) return '/app/advisor/orders';
  if (pathname.startsWith('/app/advisor/orders/')) return '/app/advisor/orders';
  if (pathname.startsWith('/app/advisor/payments')) return '/app/advisor';
  if (pathname.startsWith('/app/advisor/settings')) return '/app/advisor';
  return null;
}

export default function AdvisorShell(props: AdvisorShellProps) {
  const { children, userId, fullName, actionCount, updateCount } = props;
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const isNewOrderRoute = pathname.startsWith('/app/advisor/new');
  const isOrderDetailRoute = pathname.startsWith('/app/advisor/orders/');
  const backHref = resolveBackHref(pathname);
  const showCreateButton =
    !isNewOrderRoute &&
    !isOrderDetailRoute &&
    !pathname.startsWith('/app/advisor/settings');
  const advisorName = useMemo(() => {
    const normalized = String(fullName || '').trim();
    return normalized ? normalized.split(/\s+/)[0] || 'Asesor' : 'Asesor';
  }, [fullName]);

  return (
    <div className="advisor-app min-h-screen bg-[#090B10] text-[#F5F7FB]">
      <div className="advisor-safe-shell mx-auto flex min-h-screen max-w-screen-md flex-col">
        <header className="advisor-safe-header sticky top-0 z-20 border-b border-[#171B24] bg-[#090B10]/92 px-4 py-2 backdrop-blur">
          <div className="flex items-center justify-between gap-2.5">
            <div className="flex min-w-0 items-center gap-2">
              {backHref ? (
                <AdvisorPendingLink
                  href={backHref}
                  className="inline-flex h-9 items-center justify-center rounded-[12px] border border-[#232632] bg-[#10131A] px-3 text-sm font-medium text-[#F5F7FB]"
                >
                  Volver
                </AdvisorPendingLink>
              ) : null}

              <Link href="/app/advisor" className="min-w-0">
                <Image
                  src="/brand/vivo-fritos-horizontal.png"
                  alt="Vivo Fritos"
                  width={2080}
                  height={500}
                  priority
                  className="h-[18px] w-auto max-w-[126px] object-contain"
                />
              </Link>
            </div>

            <div className="flex items-center gap-2">
              <AdvisorInboxBell
                advisorName={advisorName}
                userId={userId}
                actionCount={actionCount}
                updateCount={updateCount}
              />
              {showCreateButton ? (
                <AdvisorPendingLink
                  href="/app/advisor/new"
                  className="inline-flex h-9 items-center rounded-[12px] bg-[#F0D000] px-3 text-sm font-semibold text-[#17191E]"
                >
                  Nuevo
                </AdvisorPendingLink>
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
                    <AdvisorPendingLink
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
                    </AdvisorPendingLink>
                  );
                })}

                {backHref ? (
                  <AdvisorPendingLink
                    href={backHref}
                    onClick={() => setMenuOpen(false)}
                    className="flex h-10 items-center rounded-[12px] px-3 text-sm font-medium text-[#AAB2C5] hover:bg-[#171B24] hover:text-[#F5F7FB]"
                  >
                    Volver
                  </AdvisorPendingLink>
                ) : null}
              </div>
            </div>
          ) : null}
        </header>

        <main className="advisor-safe-content flex-1 px-4 py-4">{children}</main>
      </div>
    </div>
  );
}
