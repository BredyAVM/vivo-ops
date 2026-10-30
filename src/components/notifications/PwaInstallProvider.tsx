'use client';

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isInstalledApp, isAppleMobile } from '@/lib/pwa/operations-push';

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type InstallContext = { installed: boolean; appleMobile: boolean; prompt: InstallPromptEvent | null };
const Context = createContext<InstallContext>({ installed: false, appleMobile: false, prompt: null });
const serverFalse = () => false;
const noSubscription = () => () => {};
function subscribeDisplayMode(callback: () => void) {
  const query = window.matchMedia('(display-mode: standalone)');
  query.addEventListener('change', callback);
  window.addEventListener('appinstalled', callback);
  return () => { query.removeEventListener('change', callback); window.removeEventListener('appinstalled', callback); };
}

// Capture the browser's prompt in the layout so navigating to Notifications does not lose it.
export function PwaInstallProvider({ children }: { children: ReactNode }) {
  const installed = useSyncExternalStore(subscribeDisplayMode, isInstalledApp, serverFalse);
  const appleMobile = useSyncExternalStore(noSubscription, isAppleMobile, serverFalse);
  const [prompt, setPrompt] = useState<InstallPromptEvent | null>(null);
  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPromptEvent);
    };
    const onInstalled = () => setPrompt(null);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  const value = useMemo(() => ({ installed, appleMobile, prompt }), [installed, appleMobile, prompt]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function InstallApplicationPanel() {
  const { installed, appleMobile, prompt } = useContext(Context);
  const [usedPrompt, setUsedPrompt] = useState<InstallPromptEvent | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const availablePrompt = prompt && prompt !== usedPrompt ? prompt : null;

  async function install() {
    if (!availablePrompt || busy) return;
    setBusy(true);
    setMessage('');
    setUsedPrompt(availablePrompt);
    try {
      await availablePrompt.prompt();
      const choice = await availablePrompt.userChoice;
      setMessage(choice.outcome === 'accepted' ? 'Instalación solicitada. Abre VIVO Admin desde su icono.' : 'Puedes instalarla después desde el menú del navegador.');
    } catch {
      setMessage('No se pudo abrir la instalación. Utiliza el menú del navegador.');
    } finally { setBusy(false); }
  }

  return <section aria-label="Instalar Administración" className="rounded-xl border border-[#292937] bg-[#111117] p-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">VIVO Admin en tu teléfono</h2>
      <span className={`text-[11px] ${installed ? 'text-emerald-300' : 'text-[#B7B7C2]'}`}>{installed ? 'Abierta como app' : 'Abierta en navegador'}</span>
    </div>
    {installed ? <p className="mt-2 text-xs text-[#B7B7C2]">Activa las notificaciones abajo y envía una prueba.</p> : <>
      {availablePrompt ? <button type="button" onClick={() => void install()} disabled={busy} className="mt-3 min-h-11 rounded-lg bg-[#FFFF00] px-3 text-xs font-semibold text-[#0B0B0D] md:min-h-8">{busy ? 'Instalando…' : 'Instalar VIVO Admin'}</button> : null}
      <p className="mt-2 text-xs leading-5 text-[#B7B7C2]">{appleMobile
        ? 'En Safari: Compartir → Añadir a pantalla de inicio. Luego abre VIVO Admin desde su icono.'
        : 'En el menú del navegador: Instalar aplicación o Añadir a pantalla de inicio. En computadora, utiliza el icono de instalación de la barra de dirección.'}</p>
      <p className="mt-1 text-[11px] leading-5 text-[#B7B7C2]">La instalación es opcional para navegar. En iPhone/iPad necesitas la app instalada e iOS/iPadOS 16.4 o posterior para recibir push.</p>
    </>}
    <p className="mt-2 text-[11px] text-[#B7B7C2]">Las órdenes y finanzas requieren conexión; no se guardan saldos para operar sin internet.</p>
    {message ? <p role="status" className="mt-2 text-xs text-[#FFFF00]">{message}</p> : null}
  </section>;
}
