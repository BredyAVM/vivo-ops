'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const links = [
  { href: '/app/kitchen/inventory', label: 'Inicio' },
  { href: '/app/kitchen/inventory/counts', label: 'Inventariar' },
  { href: '/app/kitchen/inventory/receipts', label: 'Entradas' },
  { href: '/app/kitchen/inventory/production', label: 'Producción' },
  { href: '/app/kitchen/inventory/losses', label: 'Calidad' },
  { href: '/app/kitchen/inventory/alerts', label: 'Alertas' },
];

export function InventoryNavigation() {
  const pathname = usePathname();

  return (
    <nav aria-label="Inventario de Cocina" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {links.map((link) => {
        const isActive = link.href === '/app/kitchen/inventory'
          ? pathname === link.href
          : pathname.startsWith(link.href);
        return (
          <Link
            key={link.href}
            href={link.href}
            prefetch={false}
            aria-current={isActive ? 'page' : undefined}
            className={[
              'flex min-h-11 items-center justify-center rounded-xl border px-3 text-center text-sm font-semibold transition',
              isActive
                ? 'border-[#FEEF00] bg-[#FEEF00] text-black'
                : 'border-[#30303F] bg-[#15151D] text-[#E6E6EC] hover:border-[#FEEF00]/60 hover:text-[#FEEF00]',
            ].join(' ')}
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
