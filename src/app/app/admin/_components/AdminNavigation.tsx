'use client';

import Link from '@/components/navigation/ContextLink';
import { usePathname } from 'next/navigation';
import { adminNavigation, desktopAdminNavigationGroups, mobileAdminNavigation } from '../_lib/navigation';

type AdminNavigationProps = {
  variant: 'desktop' | 'mobile';
};

export default function AdminNavigation({ variant }: AdminNavigationProps) {
  const pathname = usePathname();
  const items = variant === 'mobile' ? mobileAdminNavigation : adminNavigation;
  const activePath = items
    .map((item) => item.href.split('#')[0])
    .filter((path) => path.startsWith('/app/admin'))
    .filter((path) => pathname === path || (path !== '/app/admin' && pathname.startsWith(`${path}/`)))
    .sort((left, right) => right.length - left.length)[0];
  const isActive = (href: string) => {
    if (href.includes('#')) return false;
    const path = href.split('#')[0];
    return path === activePath;
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
    <nav aria-label="Navegación de Administración" className="grid w-full min-w-0 grid-cols-1 gap-3">
      {desktopAdminNavigationGroups.map((group) => (
        <div key={group.label} className="min-w-0">
          <p className="mb-1 px-2 text-[10px] font-medium uppercase tracking-wider text-[#777786]">{group.label}</p>
          <div className="grid min-w-0 gap-0.5">
      {group.items.map((item) => {
        const active = isActive(item.href);
        return (
          <Link
            key={item.key}
            href={item.href}
            prefetch={item.prefetch}
            aria-current={active ? 'page' : undefined}
            title={item.label}
            className={[
              'group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]',
              active
                ? 'border-[#FEEF00]/35 bg-[#FEEF00]/10 text-white'
                : 'border-transparent text-[#C8C8D1] hover:border-[#2D2D3B] hover:bg-[#17171F] hover:text-white',
            ].join(' ')}
          >
            <span
              aria-hidden="true"
              className={[
                'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[8px] font-bold tracking-tight',
                active
                  ? 'bg-[#FEEF00] text-[#0B0B0D]'
                  : 'bg-[#181820] text-[#8A8A96] group-hover:text-[#FEEF00]',
              ].join(' ')}
            >
              {item.marker}
            </span>
            <span className="min-w-0 truncate text-xs font-medium">{item.key === 'events' ? item.shortLabel : item.label}</span>
            <span className="sr-only">{item.description}</span>
          </Link>
        );
      })}
          </div>
        </div>
      ))}
    </nav>
  );
}
