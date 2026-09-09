'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LAST_MODULE_STORAGE_KEY } from '@/app/app/ModulePreference';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

type AdminSignOutButtonProps = {
  compact?: boolean;
};

export default function AdminSignOutButton({ compact = false }: AdminSignOutButtonProps) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignOut() {
    if (isSigningOut) return;

    setIsSigningOut(true);
    setError(null);

    const { error: signOutError } = await supabase.auth.signOut({ scope: 'local' });
    if (signOutError) {
      setError('No se pudo cerrar la sesión. Inténtalo de nuevo.');
      setIsSigningOut(false);
      return;
    }

    window.localStorage.removeItem(LAST_MODULE_STORAGE_KEY);
    router.replace('/login');
    router.refresh();
  }

  return (
    <div className={compact ? 'relative shrink-0' : ''}>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={isSigningOut}
        aria-label={compact ? 'Cerrar sesión' : undefined}
        className={[
          'min-h-11 rounded-xl border border-[#323240] bg-[#17171F] px-3 py-2 text-sm font-semibold text-[#F5F5F7] transition hover:border-[#555568] hover:bg-[#1C1C26] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#FEEF00] disabled:cursor-wait disabled:opacity-60',
          compact ? 'min-w-14' : 'w-full',
          error ? 'border-red-400/50 text-red-100' : '',
        ].join(' ')}
      >
        {isSigningOut ? (compact ? '…' : 'Cerrando sesión…') : compact ? 'Salir' : 'Cerrar sesión'}
      </button>
      {compact ? (
        error ? (
          <p
            className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-56 rounded-xl border border-red-400/30 bg-[#191116] p-3 text-xs leading-5 text-red-200 shadow-2xl"
            role="alert"
          >
            {error}
          </p>
        ) : null
      ) : (
        <p className="mt-2 min-h-4 text-xs text-red-300" role="status" aria-live="polite">
          {error}
        </p>
      )}
    </div>
  );
}
