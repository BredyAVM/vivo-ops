export type OperationsPushWorkspace = 'master' | 'admin';

export function operationsPushWorker(workspace: OperationsPushWorkspace) {
  return workspace === 'admin'
    ? { script: '/admin-sw.js', scope: '/app/admin' }
    : { script: '/vivo-sw.js', scope: '/app/' };
}

export function isInstalledApp() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export function isAppleMobile() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export async function getOperationsServiceWorker(workspace: OperationsPushWorkspace) {
  const config = operationsPushWorker(workspace);
  return navigator.serviceWorker.register(config.script, {
    scope: config.scope,
    updateViaCache: 'none',
  });
}

// Wait for this registration, not navigator.serviceWorker.ready (which may be another role's worker).
export async function waitForOperationsWorker(registration: ServiceWorkerRegistration) {
  if (registration.active) return registration;
  const worker = registration.installing || registration.waiting;
  if (!worker) throw new Error('El servicio de notificaciones todavía no está disponible. Intenta nuevamente.');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', check);
      if (error) reject(error); else resolve();
    };
    const check = () => {
      if (worker.state === 'activated') finish();
      else if (worker.state === 'redundant') finish(new Error('No se pudo activar el servicio de notificaciones.'));
    };
    const timer = setTimeout(() => finish(new Error('La activación tardó demasiado. Intenta nuevamente.')), 12000);
    worker.addEventListener('statechange', check);
    check();
  });
  return registration;
}

export async function detachAdminPush(accessToken: string) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/app/admin');
  // Never unsubscribe the broader Master worker or the Advisor app on logout.
  if (!registration || new URL(registration.scope).pathname !== '/app/admin') return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  try {
    if (accessToken) {
      await fetch('/api/push-subscriptions', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ accessToken, scope: 'admin', subscription: subscription.toJSON() }),
      });
    }
  } finally {
    // Stop device delivery even if the server is temporarily unreachable.
    await subscription.unsubscribe();
  }
}
