"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createSupabaseBrowser } from "@/lib/supabase/browser";

type PushState = "checking" | "unsupported" | "denied" | "ready" | "subscribed" | "error";
type PushTone = "info" | "warning" | "critical" | "success";

const PUSH_TIMEOUT_MS = 12_000;

function isStandaloneMode() {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

function isIPhoneLike() {
  if (typeof navigator === "undefined") return false;
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
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

async function getAppServiceWorker() {
  const existing = await navigator.serviceWorker.getRegistration("/app/");
  if (existing) return existing;

  return navigator.serviceWorker.register("/vivo-sw.js", {
    scope: "/app/",
    updateViaCache: "none",
  });
}

async function waitForActiveServiceWorker(registration: ServiceWorkerRegistration) {
  if (registration.active) return registration;

  const worker = registration.installing || registration.waiting;
  if (!worker) return navigator.serviceWorker.ready;

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === "activated") {
          worker.removeEventListener("statechange", onStateChange);
          resolve();
        }
        if (worker.state === "redundant") {
          worker.removeEventListener("statechange", onStateChange);
          reject(new Error("El servicio de alertas no pudo activarse."));
        }
      };

      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    }),
    "La app tardo demasiado en activar las alertas."
  );

  return navigator.serviceWorker.ready;
}

function playMasterOpsAlert(tone: PushTone = "warning") {
  try {
    const AudioContextCtor =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    const isCritical = tone === "critical";

    oscillator.type = isCritical ? "square" : "sine";
    oscillator.frequency.setValueAtTime(isCritical ? 820 : 720, context.currentTime);
    if (isCritical) {
      oscillator.frequency.setValueAtTime(1_040, context.currentTime + 0.22);
    }
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(isCritical ? 0.2 : 0.13, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (isCritical ? 0.62 : 0.36));
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + (isCritical ? 0.65 : 0.4));
    window.setTimeout(() => void context.close().catch(() => undefined), 850);
  } catch {
    // Algunos navegadores bloquean audio hasta que el usuario interactua con la pagina.
  }
}

function isMasterOpsPushUrl(value: unknown) {
  const url = String(value || "").trim();
  return url.startsWith("/app/master/ops") || url.startsWith("/app/master/dashboard");
}

export default function MasterOpsAlerts({
  publicVapidKey,
  onRefresh,
}: {
  publicVapidKey: string;
  onRefresh: () => void;
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const [pushState, setPushState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveSubscription = useCallback(
    async (subscription: PushSubscription) => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token || "";
      if (!accessToken) throw new Error("La sesion vencio. Vuelve a iniciar sesion.");

      const response = await withTimeout(
        fetch("/api/push-subscriptions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accessToken,
            scope: "master_ops",
            subscription: subscriptionToJson(subscription),
          }),
        }),
        "Guardar las alertas tardo demasiado."
      );

      const payload = (await response.json().catch(() => null)) as
        | { error?: string; code?: string }
        | null;
      if (!response.ok) {
        if (payload?.code === "missing_table") {
          throw new Error("Falta configurar la tabla de alertas.");
        }
        throw new Error(payload?.error || "No se pudo guardar este dispositivo.");
      }
    },
    [supabase]
  );

  useEffect(() => {
    let cancelled = false;

    async function bootPushState() {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
        if (!cancelled) setPushState("unsupported");
        return;
      }
      if (!publicVapidKey) {
        if (!cancelled) {
          setError("Falta configurar la clave publica de alertas.");
          setPushState("error");
        }
        return;
      }
      if (Notification.permission === "denied") {
        if (!cancelled) setPushState("denied");
        return;
      }

      try {
        const registration = await waitForActiveServiceWorker(await getAppServiceWorker());
        const subscription = await withTimeout(
          registration.pushManager.getSubscription(),
          "La app tardo demasiado en revisar las alertas."
        );

        if (subscription) {
          await saveSubscription(subscription);
        }

        if (!cancelled) {
          setError(null);
          setPushState(subscription ? "subscribed" : "ready");
        }
      } catch (bootError) {
        if (!cancelled) {
          setError(bootError instanceof Error ? bootError.message : "No se pudo revisar las alertas.");
          setPushState("error");
        }
      }
    }

    void bootPushState();
    return () => {
      cancelled = true;
    };
  }, [publicVapidKey, saveSubscription]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const onMessage = (event: MessageEvent) => {
      const data =
        event.data && typeof event.data === "object"
          ? (event.data as {
              type?: string;
              payload?: { url?: string; tone?: PushTone };
            })
          : null;
      if (data?.type !== "vivo-push" || !isMasterOpsPushUrl(data.payload?.url)) return;

      if (data.payload?.tone === "critical" || data.payload?.tone === "warning") {
        playMasterOpsAlert(data.payload.tone);
      }
      onRefresh();
    };

    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [onRefresh]);

  async function enablePush() {
    setBusy(true);
    setError(null);

    try {
      if (!publicVapidKey) throw new Error("Falta configurar la clave publica de alertas.");
      if (isIPhoneLike() && !isStandaloneMode()) {
        throw new Error("En iPhone abre VIVO OPS desde la app instalada en la pantalla de inicio.");
      }

      const permission = await Notification.requestPermission();
      if (permission === "denied") {
        setPushState("denied");
        throw new Error("El navegador bloqueo las notificaciones.");
      }
      if (permission !== "granted") {
        setPushState("ready");
        return;
      }

      const registration = await waitForActiveServiceWorker(await getAppServiceWorker());
      let subscription = await withTimeout(
        registration.pushManager.getSubscription(),
        "La app tardo demasiado en revisar las alertas."
      );
      if (!subscription) {
        subscription = await withTimeout(
          registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicVapidKey),
          }),
          "La suscripcion de alertas tardo demasiado."
        );
      }

      await saveSubscription(subscription);
      setPushState("subscribed");
      playMasterOpsAlert("warning");
    } catch (enableError) {
      setError(enableError instanceof Error ? enableError.message : "No se pudieron activar las alertas.");
      setPushState((current) => (current === "denied" ? "denied" : "error"));
    } finally {
      setBusy(false);
    }
  }

  const label =
    busy
      ? "Activando..."
      : pushState === "subscribed"
        ? "Alertas ON"
        : pushState === "checking"
          ? "Alertas..."
          : pushState === "denied"
            ? "Bloqueadas"
            : pushState === "unsupported"
              ? "No compatibles"
              : "Alertas";
  const disabled =
    busy || pushState === "checking" || pushState === "unsupported" || pushState === "denied";
  const title =
    error ||
    (pushState === "subscribed"
      ? "Alertas activas. Presiona para probar el sonido."
      : pushState === "denied"
        ? "Debes permitir notificaciones en la configuracion del navegador."
        : pushState === "unsupported"
          ? "Este navegador no admite notificaciones push."
          : "Activar alertas operativas en este dispositivo.");

  return (
    <div className="shrink-0">
      <button
        className={[
          "rounded-2xl border px-2.5 py-1.5 text-left transition disabled:cursor-not-allowed disabled:opacity-65",
          pushState === "subscribed"
            ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
            : pushState === "error" || pushState === "denied"
              ? "border-orange-400/40 bg-orange-400/10 text-orange-100"
              : "border-[#FEEF00]/35 bg-[#FEEF00]/10 text-[#FEEF00]",
        ].join(" ")}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (pushState === "subscribed") {
            playMasterOpsAlert("warning");
            return;
          }
          void enablePush();
        }}
        title={title}
      >
        <span className="block text-[9px] uppercase tracking-[0.14em] opacity-70">Dispositivo</span>
        <span className="mt-0.5 block text-[11px] font-semibold leading-none">{label}</span>
      </button>
      <span className="sr-only" aria-live="polite">
        {error || (pushState === "subscribed" ? "Alertas activadas." : "")}
      </span>
    </div>
  );
}
