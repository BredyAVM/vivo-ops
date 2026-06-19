'use client';

import { useRouter } from 'next/navigation';
import type { AppModuleDefinition } from '@/lib/app-modules';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { LAST_MODULE_STORAGE_KEY } from './ModulePreference';

type ModuleSelectorClientProps = {
  modules: AppModuleDefinition[];
  fullName: string;
  email: string;
};

export default function ModuleSelectorClient(props: ModuleSelectorClientProps) {
  const { modules, fullName, email } = props;
  const router = useRouter();
  const supabase = createSupabaseBrowser();

  const handleOpenModule = (module: AppModuleDefinition) => {
    window.localStorage.setItem(LAST_MODULE_STORAGE_KEY, module.key);
    router.push(module.href);
  };

  return (
    <main className="min-h-screen bg-[#0B0B0D] text-[#F5F5F7]">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-4 py-6 md:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4 border-b border-[#242433] pb-5">
          <div>
            <div className="text-sm uppercase tracking-[0.18em] text-[#8A8A96]">VIVO OPS</div>
            <h1 className="mt-2 text-2xl font-semibold md:text-3xl">Selecciona módulo</h1>
            <div className="mt-2 text-sm text-[#B7B7C2]">
              {fullName || email || 'Usuario'} · cada módulo muestra la misma información adaptada a su trabajo.
            </div>
          </div>

          <button
            type="button"
            onClick={async () => {
              window.localStorage.removeItem(LAST_MODULE_STORAGE_KEY);
              await supabase.auth.signOut();
              router.push('/login');
              router.refresh();
            }}
            className="rounded-xl border border-[#242433] bg-[#121218] px-4 py-2 text-sm text-[#F5F5F7]"
          >
            Cambiar usuario
          </button>
        </header>

        <section className="grid flex-1 content-start gap-3 py-6 md:grid-cols-2 xl:grid-cols-3">
          {modules.length === 0 ? (
            <div className="rounded-2xl border border-[#242433] bg-[#121218] p-5 md:col-span-2 xl:col-span-3">
              <div className="text-lg font-semibold">Sin módulos asignados</div>
              <p className="mt-2 text-sm leading-6 text-[#B7B7C2]">
                Este usuario no tiene roles activos para entrar a un módulo. Un administrador debe revisar sus
                permisos.
              </p>
            </div>
          ) : null}

          {modules.map((module) => {
            const available = module.status === 'available';

            return (
              <button
                key={module.key}
                type="button"
                onClick={() => {
                  if (available) handleOpenModule(module);
                }}
                disabled={!available}
                className={[
                  'min-h-[178px] rounded-2xl border p-4 text-left transition',
                  available
                    ? 'border-[#2A2A38] bg-[#121218] hover:border-[#FEEF00]/70 hover:bg-[#16161F]'
                    : 'cursor-not-allowed border-[#242433] bg-[#0F0F14] opacity-70',
                ].join(' ')}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold text-[#F5F5F7]">{module.label}</div>
                    <div className="mt-1 text-xs text-[#8A8A96]">{module.recommendedDevice}</div>
                  </div>
                  <span
                    className={[
                      'rounded-full border px-2.5 py-1 text-[11px] font-semibold',
                      available
                        ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                        : 'border-[#2A2A38] bg-[#0B0B0D] text-[#8A8A96]',
                    ].join(' ')}
                  >
                    {available ? 'Disponible' : 'En construcción'}
                  </span>
                </div>

                <p className="mt-4 text-sm leading-6 text-[#B7B7C2]">{module.description}</p>

                <div className="mt-5 text-sm font-semibold text-[#FEEF00]">
                  {available ? 'Entrar' : 'Próximamente'}
                </div>
              </button>
            );
          })}
        </section>
      </div>
    </main>
  );
}
