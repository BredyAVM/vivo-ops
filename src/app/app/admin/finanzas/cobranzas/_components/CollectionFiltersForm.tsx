'use client';

import Link from 'next/link';
import Form from 'next/form';
import { useState, type ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import {
  COLLECTIONS_PATH, collectionPeriod, collectionSources, collectionStages, collectionStatuses, type CollectionFilters,
} from '@/lib/admin-finance/collections-model';

const control = 'min-h-10 w-full min-w-0 rounded-lg border border-zinc-700 bg-[#15151c] px-2 text-xs text-white';
const action = 'inline-flex min-h-10 items-center rounded-lg border border-zinc-700 px-2.5 text-xs text-zinc-200 hover:border-yellow-300';
function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="flex min-w-0 flex-col gap-1 text-[11px] text-zinc-400">{label}{children}</label>;
}
function Options({ values }: { values: Record<string, string> }) {
  return Object.entries(values).map(([value, label]) => <option key={value} value={value}>{label}</option>);
}

function QueryButton() {
  const { pending } = useFormStatus();
  return <button className="min-h-10 self-end rounded-lg bg-yellow-300 px-4 text-xs font-semibold text-black disabled:opacity-50"
    type="submit" name="action" value="query" disabled={pending}>{pending ? 'Consultando…' : 'Consultar'}</button>;
}
export default function CollectionFiltersForm({ filters, people, todayIso }: {
  filters: CollectionFilters; people: { id: string; name: string }[]; todayIso: string;
}) {
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const [history, setHistory] = useState(filters.scope === 'history');
  const selectedPersonMissing = filters.person && !people.some(person => person.id === filters.person);
  return <Form action={COLLECTIONS_PATH} prefetch={false} data-collection-filters className="space-y-2 rounded-xl border border-zinc-800 bg-[#111117] p-3" key={JSON.stringify(filters)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {([['today', 'Hoy'], ['week', 'Esta semana'], ['month', 'Este mes']] as const).map(([key, label]) =>
          <button className={action} key={key} type="button" onClick={() => {
            const period = collectionPeriod(key, new Date(todayIso));
            setFrom(period.from); setTo(period.to); setHistory(false);
          }}>{label}</button>)}
        <label className="flex min-h-10 items-center gap-2 text-xs text-zinc-400">
          <input type="checkbox" checked={history} onChange={e => setHistory(e.target.checked)} />
          Todo el historial (consulta más lenta)
        </label>
        <input type="hidden" name="scope" value={history ? 'history' : 'period'} />
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Field label="Desde"><input className={control} type="date" name="from" required={!history} disabled={history} value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="Hasta (incluido)"><input className={control} type="date" name="to" required={!history} disabled={history} value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Fecha de"><select className={control} name="basis" defaultValue={filters.basis}><option value="created">Creación de la orden</option><option value="delivered">Entrega registrada</option></select></Field>
        <Field label="Cobranza"><select className={control} name="status" defaultValue={filters.status}><Options values={collectionStatuses} /></select></Field>
        <Field label="Persona"><select className={control} name="person" defaultValue={filters.person} disabled={people.length === 0 && !filters.person}><option value="">Todas las personas</option>{selectedPersonMissing && <option value={filters.person}>Vendedor seleccionado</option>}{people.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Participación de esa persona"><select className={control} name="personBasis" defaultValue={filters.personBasis}><option value="either">Creador o asesor asignado</option><option value="creator">Creó la orden</option><option value="advisor">Asesor asignado</option></select></Field>
        <Field label="Canal de venta"><select className={control} name="source" defaultValue={filters.source}><Options values={collectionSources} /></select></Field>
        <Field label="Modalidad"><select className={control} name="fulfillment" defaultValue={filters.fulfillment}><option value="all">Delivery y pickup</option><option value="pickup">Pickup / retiro</option><option value="delivery">Delivery</option></select></Field>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Field label="Buscar orden corta, cliente, teléfono o vendedor"><input className={control} type="search" name="q" maxLength={80} defaultValue={filters.q} placeholder="Ej. 2784 o nombre del cliente" /></Field>
        <QueryButton />
        <Link className={`${action} self-end justify-center`} prefetch={false} href={COLLECTIONS_PATH}>Limpiar</Link>
      </div>
      {people.length === 0 && <button className={action} type="submit" name="action" value="people" formNoValidate>Cargar vendedores (sin consultar saldos)</button>}
      <details open={filters.role !== 'all' || filters.stage !== 'all' || filters.sort !== 'pending'}>
        <summary className="cursor-pointer py-1 text-xs text-zinc-400">Más filtros</summary>
        <div className="grid grid-cols-1 gap-2 pt-2 sm:grid-cols-3">
          <Field label="Rol actual de quien creó la orden"><select className={control} name="role" defaultValue={filters.role}><option value="all">Cualquier rol</option><option value="admin">Administrador</option><option value="master">Master</option><option value="advisor">Asesor</option><option value="counter">Mostrador</option></select></Field>
          <Field label="Estado de la orden"><select className={control} name="stage" defaultValue={filters.stage}><Options values={collectionStages} /></select></Field>
          <Field label="Ordenar"><select className={control} name="sort" defaultValue={filters.sort}><option value="pending">Mayor pendiente</option><option value="oldest">Más antiguas</option><option value="newest">Más recientes</option></select></Field>
        </div>
      </details>
    </Form>;
}
