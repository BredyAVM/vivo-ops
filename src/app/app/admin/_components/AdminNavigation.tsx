'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { adminNavigation, mobileAdminNavigation } from '../_lib/navigation';

type AdminNavigationProps = {
  variant: 'desktop' | 'mobile';
};

export default function AdminNavigation({ variant }: AdminNavigationProps) {
  const pathname = usePathname();
  const isActive = (href: string) => {
    if (href.includes('#')) return false;
    const path = href.split('#')[0];
    if (!path.startsWith('/app/admin')) return false;
    if (path === '/app/admin') return pathname === path;
    return pathname === path || pathname.startsWith(`${path}/`);
  };

  if (variant === 'mobile') {
    return (
      <nav
        aria-label="Navegación principal de Administración"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-[#2A2A38] bg-[#101015]/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 backdrop-blur md:hidden"
      >
        <div className="mx-auto grid max-w-xl grid-cols-4 gap-1">
          {mobileAdminNavigation.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.key}
                href={item.href}
                prefetch={item.prefetch}
                aria-label={item.label}
                aria-current={active ? 'page' : undefined}
                className={[
                  'flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 text-[11px] font-medium transition hover:bg-[#1A1A24] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
                  active ? 'bg-[#FEEF00]/10 text-white' : 'text-[#B7B7C2]',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-6 min-w-6 items-center justify-center rounded-lg border px-1 text-[9px] font-black tracking-tight',
                    active
                      ? 'border-[#FEEF00] bg-[#FEEF00] text-[#0B0B0D]'
                      : 'border-[#333342] bg-[#181820] text-[#FEEF00]',
                  ].join(' ')}
                >
                  {item.marker}
                </span>
                <span className="max-w-full truncate">{item.shortLabel}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Navegación de Administración" className="grid gap-1.5">
      {adminNavigation.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.key}
            href={item.href}
            prefetch={item.prefetch}
            aria-current={active ? 'page' : undefined}
            className={[
              'group flex min-h-11 items-center gap-2.5 rounded-xl border px-2.5 py-2 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
              active
                ? 'border-[#FEEF00]/35 bg-[#FEEF00]/10 text-white'
                : 'border-transparent text-[#C8C8D1] hover:border-[#2D2D3B] hover:bg-[#17171F] hover:text-white',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-[9px] font-black tracking-tight',
                active
                  ? 'border-[#FEEF00]/50 bg-[#FEEF00] text-[#0B0B0D]'
                  : 'border-[#333342] bg-[#181820] text-[#FEEF00] group-hover:border-[#4A4A5E]',
              ].join(' ')}
            >
              {item.marker}
            </span>
            <span className="min-w-0 truncate text-sm font-semibold">{item.label}</span>
            <span className="sr-only">{item.description}</span>
          </Link>
        );
      })}
    </nav>
  );
}
