'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createSupabaseBrowser } from '@/lib/supabase/browser';
import { QuickLink, SectionCard, StatusBadge } from '../advisor-ui';

function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & {
    standalone?: boolean;
  }).standalone === true;
}

function permissionLabel(value: NotificationPermission | 'unsupported') {
  if (value === 'granted') return 'Permitidas';
  if (value === 'denied') return 'Bloqueadas';
  if (value === 'default') return 'Pendientes';
  return 'No disponibles';
}

function permissionTone(value: NotificationPermission | 'unsupported') {
  if (value === 'granted') return 'success' as const;
  if (value === 'denied') return 'danger' as const;
  if (value === 'default') return 'warning' as const;
  return 'neutral' as const;
}

export default function AdvisorSettingsClient({
  fullName,
  email,
}: {
  fullName: string;
  email: string;
}) {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [isPending, startTransition] = useTransition();
  const [modeLabel] = useState(() => (isStandaloneMode() ? 'App instalada' : 'Vista web'));
  const [pushPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  );
  const [displayName, setDisplayName] = useState(fullName);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function handleSaveDisplayName() {
    const nextName = displayName.trim();
    if (!nextName) {
      setError('Escribe el nombre que quieres mostrar.');
      setInfo(null);
      return;
    }

    setError(null);
    setInfo(null);
    startTransition(async () => {
      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      if (authError || !user) {
        setError(authError?.message || 'No se pudo validar la sesion.');
        return;
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert(
          {
            id: user.id,
            full_name: nextName,
          },
          { onConflict: 'id' }
        );

      if (profileError) {
        setError(profileError.message);
        return;
      }

      const { error: metadataError } = await supabase.auth.updateUser({
        data: {
          full_name: nextName,
          name: nextName,
        },
      });

      if (metadataError) {
        setError(metadataError.message);
        return;
      }

      setDisplayName(nextName);
      setInfo('Nombre actualizado para presupuestos y detalle.');
      router.refresh();
    });
  }

  function handleLogout() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        setError(signOutError.message);
        return;
      }

      router.push('/login');
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <SectionCard title="Cuenta" subtitle="Datos basicos de la sesion actual.">
        <div className="grid gap-2 text-sm text-[#AAB2C5]">
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Asesor</span>
            <span className="max-w-[62%] truncate text-right text-[#F5F7FB]">{displayName.trim() || fullName}</span>
          </div>
          <div className="flex items-center justify-between rounded-[16px] bg-[#0F131B] px-3.5 py-3">
            <span>Correo</span>
            <span className="max-w-[62%] truncate text-right text-[#F5F7FB]">{email}</span>
          </div>
        </div>

        <div className="mt-3 space-y-2">
          <label className="block">
            <div className="mb-1.5 text-[12px] font-medium text-[#AAB2C5]">Nombre para mostrar</div>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="min-w-0 w-full rounded-[16px] border border-[#232632] bg-[#0F131B] px-3.5 h-11 text-sm text-[#F5F7FB] placeholder:text-[#636C80]"
              placeholder="Como quieres aparecer"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleSaveDisplayName}
              disabled={isPending}
              className={[
                'inline-flex h-10 items-center rounded-[14px] px-4 text-sm font-semibold',
                isPending ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#F0D000] text-[#17191E]',
              ].join(' ')}
            >
              {isPending ? 'Guardando...' : 'Guardar nombre'}
            </button>
            <div className="text-xs leading-5 text-[#8B93A7]">
              Este nombre se usa en presupuesto y detalle.
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="App" subtitle="Estado rapido del telefono y los permisos.">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Modo</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">{modeLabel}</div>
              <StatusBadge label={modeLabel} tone={modeLabel === 'App instalada' ? 'success' : 'neutral'} />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
              Si quieres recibir push en iPhone, usa la app instalada desde pantalla de inicio.
            </div>
          </div>

          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3">
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#8B93A7]">Permiso push</div>
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-[#F5F7FB]">{permissionLabel(pushPermission)}</div>
              <StatusBadge label={permissionLabel(pushPermission)} tone={permissionTone(pushPermission)} />
            </div>
            <div className="mt-2 text-xs leading-5 text-[#AAB2C5]">
              Aqui puedes revisar rapido si el telefono tiene listas las notificaciones.
            </div>
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Ayuda rapida" subtitle="Atajos y revisiones utiles cuando estas operando desde el telefono.">
        <div className="grid gap-2">
          <QuickLink
            href="/app/advisor/inbox?filter=all"
            title="Revisar alertas"
            detail="Abre la bandeja completa para confirmar si hay algo pendiente o nuevo."
          />
          <QuickLink
            href="/app/advisor/orders"
            title="Ver pedidos"
            detail="Entra a la bandeja operativa para revisar vencidas, ASAP, pagos o entregas."
          />
          <div className="rounded-[18px] border border-[#232632] bg-[#0F131B] px-3.5 py-3 text-xs leading-5 text-[#AAB2C5]">
            Si una alerta no llega como push, primero revisa que la app siga instalada, que el permiso este activo y que el telefono no haya bloqueado las notificaciones.
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Sesion" subtitle="Salida segura para que se sienta como app cerrada.">
        {error ? (
          <div className="mb-3 rounded-[16px] border border-[#5E2229] bg-[#261114] px-3.5 py-3 text-sm text-[#F0A6AE]">
            {error}
          </div>
        ) : null}
        {info ? (
          <div className="mb-3 rounded-[16px] border border-[#1C5036] bg-[#0F2119] px-3.5 py-3 text-sm text-[#7CE0A9]">
            {info}
          </div>
        ) : null}
        <button
          type="button"
          onClick={handleLogout}
          disabled={isPending}
          className={[
            'inline-flex h-10 items-center rounded-[14px] px-4 text-sm font-semibold',
            isPending ? 'bg-[#232632] text-[#6F7890]' : 'bg-[#C93A3A] text-white',
          ].join(' ')}
        >
          {isPending ? 'Cerrando...' : 'Cerrar sesion'}
        </button>
      </SectionCard>
    </div>
  );
}
