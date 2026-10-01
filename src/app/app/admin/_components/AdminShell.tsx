import type { ReactNode } from 'react';
import Link from 'next/link';
import { ModulePreference } from '@/app/app/ModulePreference';
import AdminNavigation from './AdminNavigation';
import AdminSignOutButton from './AdminSignOutButton';
import AdminContextBack from './AdminContextBack';

type AdminShellProps = {
  children: ReactNode;
  userLabel: string;
  email: string;
};

export default function AdminShell({ children, userLabel, email }: AdminShellProps) {
  return (
    <div className="min-h-dvh bg-[#0B0B0D] font-sans text-[#F5F5F7]">
      <ModulePreference moduleKey="admin" />

      <a
        href="#admin-main-content"
        className="fixed left-3 top-3 z-[60] -translate-y-24 rounded-xl bg-[#FEEF00] px-4 py-3 text-sm font-bold text-[#0B0B0D] transition focus:translate-y-0 focus:outline-2 focus:outline-offset-2 focus:outline-white"
      >
        Saltar al contenido principal
      </a>

      <div className="mx-auto min-h-dvh w-full max-w-[1800px] md:grid md:grid-cols-[184px_minmax(0,1fr)]">
        <aside className="sticky top-0 hidden h-dvh min-w-0 flex-col border-r border-[#242433] bg-[#0E0E13] px-2.5 py-3 md:flex">
          <Link
            href="/app/admin"
            className="rounded-xl px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
          >
            <span className="block text-xs font-bold uppercase tracking-[0.22em] text-[#FEEF00]">VIVO OPS</span>
            <span className="mt-1 block text-base font-semibold tracking-tight">Administración</span>
          </Link>

          <div className="mt-4 min-h-0 min-w-0 flex-1 overflow-y-auto pr-1 [scrollbar-width:thin] [scrollbar-color:#383843_transparent]">
            <AdminNavigation variant="desktop" />
          </div>

          <div className="mt-2 border-t border-[#242433] pt-2">
            <div className="mb-2 min-w-0 px-1" title={email}>
              <p className="truncate text-xs font-semibold text-white">{userLabel}</p>
            </div>
            <AdminSignOutButton />
          </div>
        </aside>

        <div className="min-w-0">
          <header className="sticky top-0 z-30 flex min-h-16 items-center justify-between gap-2 border-b border-[#242433] bg-[#0B0B0D]/95 px-4 py-3 backdrop-blur md:hidden">
            <Link
              href="/app/admin"
              className="min-w-0 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
            >
              <span className="block text-[10px] font-bold uppercase tracking-[0.2em] text-[#FEEF00]">VIVO OPS</span>
              <span className="block truncate text-base font-semibold">Administración</span>
            </Link>
            <div className="flex shrink-0 items-center gap-2">
              <Link
                href="/app"
                className="flex min-h-11 shrink-0 items-center rounded-xl border border-[#2A2A38] bg-[#121218] px-3 text-xs font-semibold text-[#D4D4DC] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00]"
              >
                Módulos
              </Link>
              <AdminSignOutButton compact />
            </div>
          </header>

          <main
            id="admin-main-content"
            tabIndex={-1}
            className="mx-auto w-full max-w-[1500px] px-4 pb-28 pt-5 focus:outline-none sm:px-6 sm:pt-7 md:pb-10 lg:px-8 lg:pt-8"
          >
            <AdminContextBack />
            {children}
          </main>

          <AdminNavigation variant="mobile" />
        </div>
      </div>
    </div>
  );
}
