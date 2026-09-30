'use client';

import { useEffect, useState } from 'react';
import { authorizeCrmOrderMinimumAction, loadCrmOrderMinimumAction, type CrmOrderMinimum } from './crm-minimum-actions';

const money = (amount: number) => `$${Number(amount).toFixed(2)}`;

function MinimumRule({ rule, orderId, isAdmin, onAuthorized }: {
  rule: CrmOrderMinimum; orderId: number; isAdmin: boolean; onAuthorized: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [floor, setFloor] = useState(String(Math.min(rule.commercialUsd, rule.requiredUsd)));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());

  async function authorize() {
    if (busy) return;
    const amount = Number(floor.replace(',', '.'));
    if (!floor.trim() || !Number.isFinite(amount) || amount < 0 || amount >= rule.requiredUsd || reason.trim().length < 10) {
      setMessage('Indica un mínimo menor al de la jugada y explica el motivo (al menos 10 caracteres).');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const result = await authorizeCrmOrderMinimumAction({
        requestId, orderId, memberId: rule.memberId, fingerprint: rule.fingerprint,
        expectedCommercialUsd: rule.commercialUsd, minimumAuthorizedUsd: amount, reason,
      });
      if (!result.ok) { setMessage(result.message); return; }
      setExpanded(false);
      setMessage('Excepción autorizada. La orden no se ha modificado ni entregado.');
      onAuthorized();
    } catch {
      setMessage('No se pudo comprobar la autorización. Reintenta para consultar el resultado sin duplicarla.');
    } finally { setBusy(false); }
  }

  return <div className="space-y-2 rounded-lg border border-amber-300/30 bg-amber-300/5 p-3 text-xs text-amber-100">
    <p className="font-semibold">Condición del obsequio · {rule.playName}</p>
    <p>Compra guardada: {money(rule.commercialUsd)} · Mínimo: {money(rule.requiredUsd)}. No cuentan los obsequios ni sus ampliaciones.</p>
    {rule.authorizedFloorUsd !== null ? <p>Excepción de {rule.approvedBy || 'administrador'}: mínimo {money(rule.authorizedFloorUsd)}. Motivo: {rule.reason}</p> : null}
    <p>Si reduces la compra por debajo del mínimo autorizado, completa el consumo o retira el obsequio antes de guardar. Solo el administrador puede autorizar una excepción.</p>
    {isAdmin ? <button type="button" disabled={busy} onClick={() => setExpanded(!expanded)} className="rounded-lg border border-amber-200/40 px-3 py-2 disabled:opacity-50">
      {expanded ? 'Cerrar autorización' : 'Autorizar mínimo excepcional'}
    </button> : null}
    {expanded ? <div className="space-y-3">
      <label className="block">Compra mínima que autorizas (USD)
        <input value={floor} disabled={busy} onChange={(event) => setFloor(event.target.value)} inputMode="decimal"
          className="mt-1 block w-full rounded-lg border border-[#343440] bg-[#0B0B0D] p-2" />
      </label>
      <label className="block">Motivo de la excepción
        <textarea value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} maxLength={1000}
          className="mt-1 block w-full rounded-lg border border-[#343440] bg-[#0B0B0D] p-2" />
      </label>
      <p>Se autoriza únicamente esta orden y estos obsequios. Una compra inferior al importe autorizado seguirá bloqueada. No se cambia el precio ni se marca como pagada.</p>
      <button type="button" disabled={busy} onClick={authorize} className="rounded-lg bg-[#FEEF00] px-3 py-2 font-semibold text-black disabled:opacity-50">
        {busy ? 'Autorizando…' : 'Confirmar excepción como administrador'}
      </button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}

export default function CrmOrderMinimumPanel({ orderId, isAdmin }: { orderId: number; isAdmin: boolean }) {
  const [rules, setRules] = useState<CrmOrderMinimum[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    loadCrmOrderMinimumAction(orderId).then((data) => {
      if (active) { setRules(data); setError(''); }
    }).catch(() => { if (active) setError('No se pudieron consultar las condiciones del obsequio.'); });
    return () => { active = false; };
  }, [orderId, revision]);
  return <div className="space-y-2">
    {error ? <p role="alert" className="text-xs text-amber-100">{error} <button type="button" onClick={() => setRevision(revision + 1)} className="underline">Reintentar</button></p> : null}
    {rules.map((rule) => <MinimumRule key={`${orderId}:${rule.memberId}:${rule.fingerprint}:${rule.authorizedFloorUsd}`} rule={rule}
      orderId={orderId} isAdmin={isAdmin} onAuthorized={() => setRevision((value) => value + 1)} />)}
  </div>;
}
