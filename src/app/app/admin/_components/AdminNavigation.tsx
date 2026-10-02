'use client';

import Link from '@/components/navigation/ContextLink';
import { usePathname } from 'next/navigation';
import {
  activeAdminNavigationGroup, activeAdminNavigationKey, desktopAdminNavigationGroups,
  mobileAdminNavigation, navigationItem, type AdminNavigationItem,
} from '../_lib/navigation';

function DesktopDestination({ item, active }: { item: AdminNavigationItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      prefetch={false}
      aria-current={active ? 'page' : undefined}
      title={item.label}
      className={[
        'group flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FFFF00]',
        active ? 'bg-[#FFFF00]/10 text-[#FFFF00]' : 'text-[#BDBDC7] hover:bg-[#17171F] hover:text-white',
      ].join(' ')}
    >
      <span aria-hidden="true" className="w-5 shrink-0 text-center text-[9px] text-[#A4A4B0]">{item.marker}</span>
      <span className="min-w-0 whitespace-normal break-words font-medium leading-4">{item.label}</span>
    </Link>
  );
}

export default function AdminNavigation({ variant }: { variant: 'desktop' | 'mobile' }) {
  const pathname = usePathname();
  const activeKey = activeAdminNavigationKey(pathname);
  const activeGroup = activeAdminNavigationGroup(pathname);

  if (variant === 'mobile') {
    return (
      <nav aria-label="Navegación principal de Administración" className="fixed inset-x-0 bottom-0 z-40 border-t border-[#2A2A38] bg-[#101015]/95 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 backdrop-blur md:hidden">
        <div className="mx-auto grid max-w-xl grid-cols-4 gap-1">
          {mobileAdminNavigation.map((item) => {
            const active = item.key === activeKey || item.key === activeGroup;
            return (
              <Link key={item.key} href={item.href} prefetch={false} aria-label={item.label} aria-current={active ? (item.key === activeKey ? 'page' : 'location') : undefined}
                className={`flex min-h-12 min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[11px] font-medium focus-visible:outline-2 focus-visible:outline-[#FFFF00] ${active ? 'bg-[#FFFF00]/10 text-[#FFFF00]' : 'text-[#B7B7C2] hover:bg-[#1A1A24]'}`}>
                <span aria-hidden="true" className="text-[9px] font-bold">{item.marker}</span>
                <span className="max-w-full truncate">{item.shortLabel}</span>
              </Link>
            );
          })}
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label="Navegación de Administración" className="grid w-full min-w-0 grid-cols-1 gap-1">
      <DesktopDestination item={navigationItem('home')} active={activeKey === 'home'} />
      {desktopAdminNavigationGroups.map((group) => (
        <details key={`${group.key}:${pathname}`} open={group.key === activeGroup} className="group/section min-w-0">
          <summary className={`flex min-h-9 cursor-pointer list-none items-center justify-between gap-2 rounded-lg px-2 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-[#FFFF00] [&::-webkit-details-marker]:hidden ${group.key === activeGroup ? 'text-[#FFFF00]' : 'text-[#D0D0D8] hover:bg-[#17171F]'}`}>
            <span>{group.label}</span>
            <span aria-hidden="true" className="text-[#A4A4B0] transition-transform group-open/section:rotate-90">›</span>
          </summary>
          <div className="ml-2 mt-0.5 grid min-w-0 gap-0.5 border-l border-[#2A2A38] pl-1">
            {group.items.map((item) => (
              <DesktopDestination key={item.key} item={item.key === group.key ? { ...item, label: `Ver ${group.label.toLowerCase()}` } : item} active={item.key === activeKey} />
            ))}
          </div>
        </details>
      ))}
    </nav>
  );
}
