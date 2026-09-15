'use client';
import {useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {voidAdminClosure} from './actions';
export default function VoidClosure({closureId}:{closureId:number}) {
  const router=useRouter();const [reason,setReason]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const guard=useRef(false);
  return <details className="rounded-xl border border-[#292937] p-4"><summary className="cursor-pointer text-sm">Anular este cierre</summary><form className="mt-3 space-y-3" onSubmit={async e=>{e.preventDefault();if(guard.current)return;guard.current=true;setBusy(true);try{await voidAdminClosure(closureId,reason);router.refresh();}catch(e){setError(e instanceof Error?e.message:'No se pudo confirmar la anulación; reintenta el mismo cierre.');}finally{guard.current=false;setBusy(false);}}}><p className="text-xs text-[#aaa]">Solo se permite cuando no hay cierres posteriores ni diferencias resueltas que dependan de este. Conserva el historial; no borra registros.</p><label className="block text-sm">Motivo<input required minLength={6} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} disabled={busy} className="mt-1 min-h-11 w-full rounded-lg border border-[#343442] bg-[#14141c] px-3"/></label><button disabled={busy} className="min-h-11 rounded-lg border border-red-500/40 px-4 text-sm text-red-200">{busy?'Comprobando…':'Confirmar anulación'}</button>{error?<p role="alert" className="text-sm text-orange-200">{error}</p>:null}</form></details>;
}
