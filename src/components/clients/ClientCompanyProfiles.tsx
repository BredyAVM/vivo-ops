'use client';

import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { listClientCompaniesAction, saveClientCompanyAction } from '@/app/app/clients/company-profile-actions';
import {
  canApplyDefaultCompany, companyDocumentSignature, normalizeCompanyDocumentData,
  type ClientCompanyProfile, type CompanyDocumentData,
} from '@/lib/clients/company-profiles';

type Props = {
  clientId: number;
  value: CompanyDocumentData;
  autoSelectDefault: boolean;
  disabled?: boolean;
  onApply: (data: CompanyDocumentData) => void;
};

export default function ClientCompanyProfiles({ clientId, value, autoSelectDefault, disabled, onApply }: Props) {
  const [profiles, setProfiles] = useState<ClientCompanyProfile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [label, setLabel] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const savingRef = useRef(false);
  const newIdRef = useRef<string | null>(null);
  const alive = useRef(true);
  const selected = profiles.find(profile => profile.id === selectedId);

  function selectProfile(profile: ClientCompanyProfile | undefined) {
    setSelectedId(profile?.id ?? '');
    setLabel(profile?.label ?? '');
    setIsDefault(profile?.is_default ?? false);
    if (profile) onApply(normalizeCompanyDocumentData(profile.data));
    setMessage('');
  }

  const beforeLoad = useEffectEvent(() => ({ signature: companyDocumentSignature(value), autoSelectDefault }));
  const receiveProfiles = useEffectEvent((rows: ClientCompanyProfile[], initial: string, allowDefault: boolean) => {
    setProfiles(rows);
    const matching = rows.find(profile => companyDocumentSignature(profile.data) === companyDocumentSignature(value));
    const principal = rows.find(profile => profile.is_default);
    if (principal && !disabled && canApplyDefaultCompany(allowDefault, initial, companyDocumentSignature(value))) {
      selectProfile(principal);
    } else {
      // Matching is cosmetic: never replace a restored order/draft with newer saved data.
      setSelectedId(matching?.id ?? '');
      setLabel(matching?.label ?? '');
      setIsDefault(matching?.is_default ?? false);
    }
  });

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initial = beforeLoad();
    setLoading(true);
    setError('');
    void listClientCompaniesAction(clientId).then(result => {
      if (cancelled) return;
      if (!result.ok) { setError(result.error); return; }
      receiveProfiles(result.profiles, initial.signature, initial.autoSelectDefault && reload === 0);
    }).catch(() => {
      if (!cancelled) setError('No se pudieron cargar las empresas. Tus datos del pedido se conservan.');
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [clientId, reload]);

  async function save(asNew: boolean) {
    if (savingRef.current || loading || disabled || (!asNew && !selected)) return;
    if (!label.trim()) { setError('Escribe un nombre para identificar la empresa.'); return; }
    savingRef.current = true;
    setSaving(true);
    setError('');
    setMessage('');
    if (asNew && !newIdRef.current) newIdRef.current = crypto.randomUUID();
    try {
      const result = await saveClientCompanyAction({
        clientId, id: asNew ? newIdRef.current! : selected!.id,
        expectedVersion: asNew ? null : selected!.version,
        label, data: value, isDefault,
      });
      if (!alive.current) return;
      if (!result.ok) { setError(result.error); return; }
      newIdRef.current = null;
      setProfiles(result.profiles);
      const saved = result.profiles.find(profile => profile.id === result.savedId);
      setSelectedId(saved?.id ?? '');
      setLabel(saved?.label ?? '');
      setIsDefault(saved?.is_default ?? false);
      setMessage(asNew ? 'Nueva empresa guardada. Las otras empresas no cambiaron.' : 'Empresa actualizada. Los pedidos anteriores no cambiaron.');
    } catch {
      if (alive.current) setError('No se pudo confirmar el guardado. Puedes intentar de nuevo sin duplicar la empresa.');
    } finally {
      savingRef.current = false;
      if (alive.current) setSaving(false);
    }
  }

  const fieldClass = 'min-h-10 w-full min-w-0 rounded-xl border border-[#282C38] bg-[#0C1018] px-3 py-2 text-base text-[#F5F7FB]';
  const busy = loading || saving || disabled;
  return (
    <div className="min-w-0 space-y-2 rounded-2xl border border-[#282C38] p-3">
      <label className="block space-y-1 text-xs text-[#B7B7C2]">
        <span className="font-semibold text-[#F5F7FB]">Empresa para factura o nota de entrega</span>
        <select className={fieldClass} value={selectedId} disabled={busy} onChange={event => selectProfile(profiles.find(profile => profile.id === event.target.value))}>
          <option value="">{loading ? 'Cargando empresas…' : 'Datos de este pedido / nueva empresa'}</option>
          {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}{profile.is_default ? ' · Principal' : ''}</option>)}
        </select>
      </label>
      <p className="text-xs leading-relaxed text-[#9CA3B4]">Elige una empresa o edita los datos de los documentos abajo. Solo se guardan en su ficha si lo indicas.</p>
      <details>
        <summary className="cursor-pointer text-xs font-medium text-[#FEEF00]">Guardar o actualizar empresa</summary>
        <div className="mt-3 space-y-2">
          <label className="block space-y-1 text-xs text-[#B7B7C2]">
            <span>Nombre de la opción</span>
            <input className={fieldClass} value={label} onChange={event => setLabel(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} maxLength={80} placeholder="Ej.: Empresa A o Sucursal centro" disabled={busy} />
          </label>
          <label className="flex items-center gap-2 text-xs text-[#F5F7FB]">
            <input type="checkbox" checked={isDefault} onChange={event => setIsDefault(event.target.checked)} disabled={busy} />
            Usar como principal en próximos pedidos
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => void save(true)} className="rounded-xl bg-[#FEEF00] px-3 py-2 text-xs font-semibold text-black disabled:opacity-50">Guardar como nueva</button>
            {selected ? <button type="button" disabled={busy} onClick={() => void save(false)} className="rounded-xl border border-[#353B4A] px-3 py-2 text-xs font-medium text-[#F5F7FB] disabled:opacity-50">Actualizar seleccionada</button> : null}
          </div>
          <p className="text-xs text-[#9CA3B4]">Usa un nombre distinto al guardar otra empresa. La primera empresa será la principal.</p>
        </div>
      </details>
      {saving ? <p role="status" className="text-xs text-[#B7B7C2]">Guardando empresa…</p> : null}
      {message ? <p role="status" className="text-xs text-emerald-300">{message}</p> : null}
      {error ? <div role="alert" className="space-y-1 text-xs text-red-300"><p>{error}</p><button type="button" disabled={saving || loading} onClick={() => { newIdRef.current = null; setReload(current => current + 1); }} className="underline">Recargar empresas</button></div> : null}
    </div>
  );
}
