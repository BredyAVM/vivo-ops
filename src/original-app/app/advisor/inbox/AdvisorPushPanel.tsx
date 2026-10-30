'use client';

import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

type PushState = 'checking' | 'unsupported' | 'denied' | 'ready' | 'subscribed' | 'error';

const PUSH_TIMEOUT_MS = 12000;

function isStandaloneMode() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(display-mode: standalone)').matches || (window.navigator as Navigator & {
    standalone?: boolean;
  }).standalone === true;
}

function isIPhoneLike() {
  if (typeof navigator === 'undefined') return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

function subscriptionToJson(subscription: PushSubscription) {
  return subscription.toJSON() as {
    endpoint: string;
    keys: {
      p256dh: string;
      auth: string;
    };
  };
}

async function withTimeout<T>(promise: Promise<T>, message: string) {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), PUSH_TIMEOUT_MS);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function getAdvisorServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration('/app/advisor/');
  if (existing) return existing;

  return navigator.serviceWorker.register('/advisor-sw.js', {
    scope: '/app/advisor/',
    updateViaCache: 'none',
  });
}

async function waitForActiveServiceWorker(registration: ServiceWorkerRegistration) {
  if (registration.active) return registration;

  const worker = registration.installing || registration.waiting;
  if (!worker) {
    return navigator.serviceWorker.ready;
  }

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === 'activated') {
          worker.removeEventListener('statechange', onStateChange);
          resolve();
        }
      };

      worker.addEventListener('statechange', onStateChange);

      if (worker.state === 'activated') {
        worker.removeEventListener('statechange', onStateChange);
        resolve();
      }

      if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onStateChange);
        reject(new Error('El servicio de notificaciones no pudo activarse.'));
      }
    }),
    'La app tardo demasiado en activar el servicio de notificaciones.'
  );

  return navigator.serviceWorker.ready;
}

export default function AdvisorPushPanel({ publicVapidKey }: { publicVapidKey: string }) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [pushState, setPushState] = useState<PushState>('checking');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [showInstallHint, setShowInstallHint] = useState(false);
  const [stepLabel, setStepLabel] = useState<string | null>(null);

  useEffect(() => {
    async function boot() {
      setShowInstallHint(isIPhoneLike() && !isStandaloneMode());

      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        setPushState('unsupported');
        return;
      }

      if (!publicVapidKey) {
        setPushState('error');
        setError('Falta configurar la clave publica de notificaciones.');
        return;
      }

      if (Notification.permission === 'denied') {
        setPushState('denied');
        return;
      }

      try {
        const initialRegistration = await withTimeout(
          getAdvisorServiceWorker(),
          'La app tardo demasiado en registrar las notificaciones.'
        );
        const registration = await waitForActiveServiceWorker(initialRegistration);
        const currentSubscription = await withTimeout(
          registration.pushManager.getSubscription(),
          'La app tardo demasiado en revisar la suscripcion push.'
        );
        setSubscription(currentSubscription);
        setPushState(currentSubscription ? 'subscribed' : 'ready');
      } catch (err) {
        setPushState('error');
        setError(err instanceof Error ? err.message : 'No se pudo revisar el estado de notificaciones.');
      }
    }

    void boot();
  }, [publicVapidKey]);

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || '';
  }

  async function enablePush() {
    setBusy(true);
    setError(null);
    setMessage(null);
    setStepLabel('Pidiendo permiso...');

    try {
      if (isIPhoneLike() && !isStandaloneMode()) {
        throw new Error('En iPhone debes abrir VIVO OPS desde la app instalada en pantalla de inicio.');
      }

      const permission = await Notification.requestPermission();
      if (permission === 'denied') {
        setPushState('denied');
        setError('El navegador bloqueo las notificaciones.');
        return;
      }

      setStepLabel('Registrando la app...');
      const initialRegistration = await withTimeout(
        getAdvisorServiceWorker(),
        'La app tardo demasiado en registrar el servicio de notificaciones.'
      );
      const registration = await waitForActiveServiceWorker(initialRegistration);

      setStepLabel('Revisando suscripcion...');
      let nextSubscription = await withTimeout(
        registration.pushManager.getSubscription(),
        'La app tardo demasiado en revisar si este telefono ya estaba suscrito.'
      );
      if (!nextSubscription) {
        setStepLabel('Creando suscripcion push...');
        nextSubscription = await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey),
          }),
          'La suscripcion push tardo demasiado en responder.'
        );
      }

      setStepLabel('Guardando telefono...');
      const accessToken = await getAccessToken();
      const response = await withTimeout(
        fetch('/api/advisor/push-subscriptions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            accessToken,
            subscription: subscriptionToJson(nextSubscription),
          }),
        }),
        'Guardar la suscripcion tardo demasiado. Revisa conexion y variables de entorno.'
      );

      const payload = (await response.json()) as { error?: string; code?: string };
      if (!response.ok) {
        if (payload.code === 'missing_table') {
          throw new Error('Falta crear la tabla de suscripciones push en Supabase.');
        }
        throw new Error(payload.error || 'No se pudo guardar la suscripcion.');
      }

      setSubscription(nextSubscription);
      setPushState('subscribed');
      setMessage('Notificaciones activadas en este telefono.');
    } catch (err) {
      setPushState('error');
      setError(err instanceof Error ? err.message : 'No se pudo activar push.');
    } finally {
      setStepLabel(null);
      setBusy(false);
    }
  }

  async function disablePush() {
    if (!subscription) return;

    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      setStepLabel('Quitando suscripcion...');
      const accessToken = await getAccessToken();
      await fetch('/api/advisor/push-subscriptions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accessToken,
          subscription: subscriptionToJson(subscription),
        }),
      });

      await subscription.unsubscribe();
      setSubscription(null);
      setPushState(Notification.permission === 'granted' ? 'ready' : 'checking');
      setMessage('Notificaciones desactivadas en este telefono.');
    } catch (err) {
      setPushState('error');
      setError(err instanceof Error ? err.message : 'No se pudo desactivar push.');
    } finally {
      setStepLabel(null);
      setBusy(false);
    }
  }

  async function sendTestPush() {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      setStepLabel('Enviando prueba...');
      const accessToken = await getAccessToken();
      const response = await withTimeout(
        fetch('/api/advisor/push-notifications/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accessToken }),
        }),
        'La prueba tardo demasiado en responder desde el servidor.'
      );

      const payload = (await response.json()) as {
        error?: string;
        code?: string;
        delivered?: number;
        failures?: string[];
      };
      if (!response.ok) {
        if (payload.code === 'missing_table') {
          throw new Error('Falta crear la tabla de suscripciones push en Supabase.');
        }
        throw new Error(payload.error || 'No se pudo enviar la notificacion de prueba.');
      }

      setMessage(
        payload.delivered && payload.delivered > 0
          ? 'Prueba enviada al telefono.'
          : payload.failures && payload.failures.length > 0
            ? `La suscripcion quedo guardada, pero Apple rechazo la push: ${payload.failures[0]}`
            : 'La suscripcion quedo guardada, pero no se entrego ninguna prueba.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo enviar la prueba.');
    } finally {
      setStepLabel(null);
      setBusy(false);
    }
  }

  return (
    <section className="rounded-[24px] border border-[#232632] bg-[#12151d] px-4 py-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-[#F5F7FB]">Notificaciones push</h3>
          <p className="mt-1 text-xs leading-5 text-[#8B93A7]">
            Activa avisos reales en el telefono para pedidos, cambios y pagos.
          </p>
        </div>
        <span
          className={[
            'rounded-full border px-2.5 py-1 text-[11px] font-medium',
            pushState === 'subscribed'
              ? 'border-[#1C5036] bg-[#0F2119] text-[#7CE0A9]'
              : pushState === 'denied' || pushState === 'error'
                ? 'border-[#5E2229] bg-[#261114] text-[#F0A6AE]'
                : 'border-[#2A3040] bg-[#151925] text-[#CCD3E2]',
          ].join(' ')}
        >
          {pushState === 'subscribed'
            ? 'Activas'
            : pushState === 'denied'
              ? 'Bloqueadas'
              : pushState === 'unsupported'
                ? 'No disponibles'
                : 'Pendientes'}
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {pushState !== 'subscribed' ? (
          <button
            type="button"
            onClick={() => void enablePush()}
            disabled={busy || pushState === 'unsupported'}
            className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E] disabled:bg-[#232632] disabled:text-[#6F7890]"
          >
            {busy ? 'Activando...' : 'Activar push'}
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void sendTestPush()}
              disabled={busy}
              className="inline-flex h-10 items-center rounded-[14px] bg-[#F0D000] px-4 text-sm font-semibold text-[#17191E] disabled:bg-[#232632] disabled:text-[#6F7890]"
            >
              {busy ? 'Enviando...' : 'Enviar prueba'}
            </button>
            <button
              type="button"
              onClick={() => void disablePush()}
              disabled={busy}
              className="inline-flex h-10 items-center rounded-[14px] border border-[#232632] px-4 text-sm font-medium text-[#F5F7FB] disabled:text-[#6F7890]"
            >
              Desactivar
            </button>
          </>
        )}
      </div>

      {showInstallHint ? (
        <div className="mt-3 rounded-[16px] border border-[#3B3220] bg-[#1C170C] px-3 py-3 text-xs leading-5 text-[#EED991]">
          En iPhone, las push solo funcionan desde la app instalada en pantalla de inicio. Abrela como app,
          no desde Safari, y luego toca <span className="font-semibold text-[#FFF3BE]">Activar push</span>.
        </div>
      ) : null}

      {busy && stepLabel ? <div className="mt-3 text-xs text-[#CCD3E2]">{stepLabel}</div> : null}
      {message ? <div className="mt-3 text-sm text-[#7CE0A9]">{message}</div> : null}
      {error ? <div className="mt-3 text-sm text-[#F0A6AE]">{error}</div> : null}
    </section>
  );
}
