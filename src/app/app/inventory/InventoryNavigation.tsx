'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type NavigationItem = {
  href: string;
  label: string;
  match?: string;
};

const PRIMARY_ITEMS: NavigationItem[] = [
  { href: '/app/inventory', label: 'Resumen' },
  { href: '/app/inventory/configure?view=edit', label: 'Productos', match: '/app/inventory/configure' },
  { href: '/app/inventory/operations', label: 'Entradas y operaciones' },
  { href: '/app/inventory/counts', label: 'Conteos' },
  { href: '/app/inventory/alerts', label: 'Alertas' },
];

const SHARED_SECONDARY_ITEMS: NavigationItem[] = [
  { href: '/app/inventory/products', label: 'Mapa de descuentos' },
  { href: '/app/inventory/recipes', label: 'Preparaciones' },
  { href: '/app/inventory/reports', label: 'Historial y reportes' },
];

const ADMIN_SECONDARY_ITEMS: NavigationItem[] = [
  { href: '/app/inventory/adjustments', label: 'Ajustes administrativos' },
  { href: '/app/inventory/readiness', label: 'Auditoría técnica' },
];

function isCurrentPath(pathname: string, item: NavigationItem) {
  if (item.href === '/app/inventory') return pathname === item.href;
  return pathname.startsWith(item.match ?? item.href);
}

export default function InventoryNavigation({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const secondaryItems = isAdmin
    ? [...SHARED_SECONDARY_ITEMS, ...ADMIN_SECONDARY_ITEMS]
    : SHARED_SECONDARY_ITEMS;
  const secondaryActive = secondaryItems.some((item) => isCurrentPath(pathname, item));

  return (
    <nav aria-label="Secciones de Inventario General" className="flex flex-wrap items-center gap-2">
      {PRIMARY_ITEMS.map((item) => {
        const active = isCurrentPath(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            prefetch={false}
            aria-current={active ? 'page' : undefined}
            className={active
              ? 'rounded-xl border border-[#FEEF00]/60 bg-[#FEEF00]/10 px-3 py-2 text-sm font-semibold text-[#FEEF00]'
              : 'rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] transition hover:border-[#FEEF00]/45 hover:text-white'}
          >
            {item.label}
          </Link>
        );
      })}

      <details className="group relative">
        <summary
          className={secondaryActive
            ? 'cursor-pointer list-none rounded-xl border border-[#FEEF00]/60 bg-[#FEEF00]/10 px-3 py-2 text-sm font-semibold text-[#FEEF00] marker:hidden'
            : 'cursor-pointer list-none rounded-xl border border-[#2A2A39] bg-[#15151D] px-3 py-2 text-sm text-[#D5D5DE] marker:hidden hover:border-[#FEEF00]/45 hover:text-white'}
        >
          Más herramientas <span aria-hidden="true" className="ml-1 text-xs">▾</span>
        </summary>
        <div className="absolute right-0 z-30 mt-2 w-64 rounded-2xl border border-[#30303E] bg-[#15151D] p-2 shadow-2xl shadow-black/50">
          {secondaryItems.map((item) => {
            const active = isCurrentPath(pathname, item);
            return (
              <Link
                key={item.href}
                href={item.href}
                prefetch={false}
                aria-current={active ? 'page' : undefined}
                className={active
                  ? 'block rounded-xl bg-[#FEEF00]/10 px-3 py-2.5 text-sm font-semibold text-[#FEEF00]'
                  : 'block rounded-xl px-3 py-2.5 text-sm text-[#C8C8D2] hover:bg-white/5 hover:text-white'}
              >
                {item.label}
              </Link>
            );
          })}
        </div>
      </details>
    </nav>
  );
}
