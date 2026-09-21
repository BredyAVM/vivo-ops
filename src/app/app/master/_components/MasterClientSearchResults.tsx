'use client';

import { useEffect, useRef, useState } from 'react';
import type { ClientSearchSummary } from '@/lib/search/client-search';
import { loadMasterClientCommercialProfileAction } from '../dashboard/actions';

type Profile = {
  metrics?: { historical_purchase_count?: number; live_purchase_count?: number; last_purchase_on?: string };
  recent_activity?: Array<{ fact_key: string; origin: string; purchased_at: string; net_total_usd: number; source_control?: string }>;
  pending_order_count?: number;
};

function dateLabel(value?: string) {
  if (!value) return 'Sin compras registradas';
  const date = new Date(value.length === 10 ? value + 'T12:00:00-04:00' : value);
  return Number.isNaN(date.getTime()) ? 'Sin fecha' : date.toLocaleDateString('es-VE', { timeZone: 'America/Caracas' });
}

function ClientProfileDialog({ client, onClose }: { client: ClientSearchSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadMasterClientCommercialProfileAction({ clientId: client.id, recentLimit: 10 })
      .then((data) => { if (!cancelled) setProfile(data as Profile); })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : 'No se pudo cargar la ficha.'); });
    return () => { cancelled = true; };
  }, [client.id, attempt]);

  return (
    <dialog ref={dialog} onCancel={onClose} aria-label={'Ficha de ' + client.full_name}
      className="fixed inset-0 m-auto max-h-[85dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-2xl border border-[#303040] bg-[#121218] p-5 text-[#F5F5F7] shadow-2xl backdrop:bg-black/70">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="break-words text-lg font-semibold">{client.full_name}</h2>
          <p className="mt-1 text-sm text-[#B7B7C2]">{client.phone || 'Sin teléfono'}</p>
          <p className="mt-1 text-xs text-[#8A8A96]">Ficha del cliente · No es una orden</p>
        </div>
        <button type="button" autoFocus onClick={onClose} className="rounded-lg border border-[#3A3A4A] px-3 py-2 text-sm">Cerrar</button>
      </div>
      {error ? (
        <div className="mt-4 text-sm text-red-300" role="alert">
          {error}
          <button type="button" className="ml-3 underline" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>Reintentar</button>
        </div>
      ) : !profile ? <p className="mt-4 text-sm text-[#B7B7C2]" role="status">Cargando historial del cliente...</p> : (
        <div className="mt-4 space-y-4">
          <dl className="grid grid-cols-2 gap-3 rounded-xl bg-[#0B0B0D] p-3 text-sm">
            <div><dt className="text-[#8A8A96]">Compras históricas</dt><dd>{profile.metrics?.historical_purchase_count ?? 0}</dd></div>
            <div><dt className="text-[#8A8A96]">Compras actuales</dt><dd>{profile.metrics?.live_purchase_count ?? 0}</dd></div>
            <div><dt className="text-[#8A8A96]">Última compra</dt><dd>{dateLabel(profile.metrics?.last_purchase_on)}</dd></div>
            <div><dt className="text-[#8A8A96]">Pedidos en curso</dt><dd>{profile.pending_order_count ?? 0}</dd></div>
          </dl>
          <h3 className="text-sm font-semibold">Actividad reciente</h3>
          {!profile.recent_activity?.length ? <p className="text-sm text-[#8A8A96]">Sin compras registradas.</p> : (
            <ul className="divide-y divide-[#303040]">
              {profile.recent_activity.map((entry) => (
                <li key={entry.fact_key} className="flex justify-between gap-3 py-3 text-sm">
                  <div><div>{dateLabel(entry.purchased_at)}</div><div className="text-xs text-[#8A8A96]">{entry.origin === 'historical' ? 'Compra histórica importada' : 'Compra del sistema actual'}{entry.source_control ? ' · ' + entry.source_control : ''}</div></div>
                  <div className="shrink-0">{Number(entry.net_total_usd).toLocaleString('es-VE', { style: 'currency', currency: 'USD' })}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </dialog>
  );
}

export default function MasterClientSearchResults({ clients }: { clients: ClientSearchSummary[] }) {
  const [selected, setSelected] = useState<ClientSearchSummary | null>(null);
  if (!clients.length) return null;
  return (
    <div className="border-t border-[#303040]">
      <p className="px-4 pt-3 text-[11px] uppercase tracking-wide text-[#8A8A96]">Clientes · ficha e historial</p>
      {clients.map((client) => (
        <button key={client.id} type="button" onClick={() => setSelected(client)}
          className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-[#121218]">
          <span className="min-w-0"><span className="block truncate text-sm font-medium">{client.full_name}</span><span className="block text-xs text-[#B7B7C2]">{client.phone || 'Sin teléfono'}</span></span>
          <span className="shrink-0 text-xs text-[#FEEF00]">Ver ficha</span>
        </button>
      ))}
      {selected ? <ClientProfileDialog key={selected.id} client={selected} onClose={() => setSelected(null)} /> : null}
    </div>
  );
}
