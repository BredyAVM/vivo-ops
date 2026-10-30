'use client';

import { useEffect, useRef, useState } from 'react';
import { authorizeCrmOrderValidityAction, loadCrmOrderValidityAction, type CrmOrderValidity } from './crm-validity-actions';

const dateLabel = (value: string | null) => value ? value.split('-').reverse().join('/') : 'Sin fecha';
const todayVE = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function ValidityRule({ rule, orderId, onAuthorized, closed }: {
  rule: CrmOrderValidity; orderId: number; onAuthorized: () => void; closed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [through, setThrough] = useState(rule.authorizedThrough ?? rule.scheduledOn ?? todayVE());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const submitting = useRef(false);
  const request = useRef<{ payload: string; id: string } | null>(null);
  async function authorize() {
    if (submitting.current) return;
    if (!through || reason.trim().length < 10) { setMessage('Selecciona la fecha y explica el motivo (al menos 10 caracteres).'); return; }
    const payload = JSON.stringify([through, reason.trim(), rule.fingerprint]);
    if (request.current?.payload !== payload) request.current = { payload, id: crypto.randomUUID() };
    submitting.current = true; setBusy(true); setMessage('');
    try {
      const result = await authorizeCrmOrderValidityAction({ requestId: request.current.id,
        orderId, memberId: rule.memberId, fingerprint: rule.fingerprint, authorizedThrough: through, reason });
      if (!result.ok) { setMessage(result.message); return; }
      setExpanded(false);
      setMessage('Autorización guardada. No se cambió la fecha de la orden ni se marcó como entregada.');
      onAuthorized();
    } catch {
      setMessage('No se pudo confirmar el resultado. Reintenta; la misma solicitud no se duplicará.');
    } finally { submitting.current = false; setBusy(false); }
  }
  return <div className="space-y-2 rounded-lg border border-amber-300/30 bg-amber-300/5 p-3 text-xs text-amber-100">
    <p className="font-semibold">Vigencia · {rule.playName}</p>
    <p>Jugada hasta {dateLabel(rule.endsOn)} · Pedido para {dateLabel(rule.scheduledOn)}.</p>
    {rule.authorizedThrough ? <p>Excepción hasta {dateLabel(rule.authorizedThrough)} (hora de Venezuela), por {rule.approvedBy || 'responsable autorizado'}. Motivo: {rule.reason}</p> : null}
    <p>{closed ? 'Pedido cerrado. La autorización se conserva para consulta; no admite nuevas excepciones.' : rule.eligible ? 'Fecha habilitada para este obsequio.' : 'Requiere revisión: no avanzar a cocina ni entregar sin resolver la vigencia.'}</p>
    {!closed && rule.canAuthorize ? <button type="button" disabled={busy} aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="rounded-lg border border-amber-200/40 px-3 py-2 disabled:opacity-50">
      {expanded ? 'Cerrar autorización' : 'Autorizar fecha excepcional'}
    </button> : !closed ? <p>{rule.authorizationRoleAllowed ? 'Esta condición no se puede exceptuar desde esta orden.' : 'Solo el administrador puede autorizar. Tu acceso es de consulta.'}</p> : null}
    {expanded && !closed && rule.canAuthorize ? <div className="space-y-3">
      <label className="block">Permitir entrega hasta (inclusive)
        <input type="date" value={through} min={todayVE()} disabled={busy} onChange={(event) => setThrough(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#343440] bg-[#0B0B0D] p-2" />
      </label>
      <label className="block">Motivo
        <textarea value={reason} disabled={busy} maxLength={1000} onChange={(event) => setReason(event.target.value)} className="mt-1 block w-full rounded-lg border border-[#343440] bg-[#0B0B0D] p-2" />
      </label>
      <p>Solo cubre esta orden y sus obsequios actuales. No reabre la campaña, no duplica el beneficio ni cambia costos o mínimos de compra. Después puedes reprogramar la orden dentro del plazo autorizado.</p>
      <button type="button" disabled={busy} onClick={authorize} className="rounded-lg bg-[#FEEF00] px-3 py-2 font-semibold text-black disabled:opacity-50">{busy ? 'Autorizando…' : 'Confirmar excepción de fecha'}</button>
    </div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}

export default function CrmOrderValidityPanel({ orderId, closed = false }: { orderId: number; closed?: boolean }) {
  const [rules, setRules] = useState<CrmOrderValidity[]>([]);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    loadCrmOrderValidityAction(orderId).then((data) => {
      if (active) { setRules(data); setError(''); }
    }).catch(() => { if (active) setError('No se pudo consultar la vigencia de los obsequios.'); });
    return () => { active = false; };
  }, [orderId, revision]);
  return <div className="space-y-2">
    {error ? <p role="alert" className="text-xs text-amber-100">{error} <button type="button" onClick={() => setRevision((value) => value + 1)} className="underline">Reintentar</button></p> : null}
    {rules.map((rule) => <ValidityRule key={`${orderId}:${rule.memberId}:${rule.fingerprint}`} rule={rule} orderId={orderId} closed={closed} onAuthorized={() => setRevision((value) => value + 1)} />)}
  </div>;
}
