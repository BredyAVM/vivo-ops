'use client';

import {isValidElement, useCallback, useEffect, useRef, useState, useTransition, type ReactNode} from 'react';
import {useRouter} from 'next/navigation';
import {loadMasterOpsInventoryAlertSummaryAction} from './before-inventory-action';

type Snapshot = {snapshotAt:string;orders:unknown[];stats:unknown;inventoryNavigation?:ReactNode};
type Job = {resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>};

export default function CpuCycleDriver({workspace,variant}:{workspace:ReactNode;variant:'before'|'after'}) {
  const router=useRouter();
  const [,startTransition]=useTransition();
  const snapshot=isValidElement<Snapshot>(workspace)?workspace.props:null;
  const [ready,setReady]=useState(false);
  const [running,setRunning]=useState(false);
  const [completed,setCompleted]=useState(0);
  const [result,setResult]=useState('');
  const [error,setError]=useState('');
  const job=useRef<Job|null>(null);
  const lastSnapshot=useRef('');
  useEffect(()=>{
    if(!snapshot?.snapshotAt||lastSnapshot.current===snapshot.snapshotAt)return;
    lastSnapshot.current=snapshot.snapshotAt;
    (async()=>{
      if(variant==='before'){
        const inventory=await loadMasterOpsInventoryAlertSummaryAction();
        if(!inventory.ok)throw Error('No se completó la lectura de inventario de prueba.');
      }
      setReady(true);
      if(job.current){const current=job.current;job.current=null;clearTimeout(current.timer);current.resolve();}
    })().catch((cause:unknown)=>{
      const message=cause instanceof Error?cause.message:String(cause);setError(message);
      if(job.current){const current=job.current;job.current=null;clearTimeout(current.timer);current.reject(Error(message));}
    });
  },[snapshot?.snapshotAt,variant]);
  const cycle=useCallback(()=>new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{job.current=null;reject(Error('La actualización de prueba agotó su tiempo.'));},20000);
    job.current={resolve,reject,timer};
    startTransition(()=>router.refresh());
  }),[router]);
  const run=async(count:number)=>{
    setRunning(true);setCompleted(0);setResult('');setError('');
    const startUtc=new Date().toISOString();
    try{
      for(let i=0;i<count;i++){await cycle();setCompleted(i+1);await new Promise(resolve=>setTimeout(resolve,30));}
      setResult(JSON.stringify({variant,cycles:count,startUtc,endUtc:new Date().toISOString(),requestsPerCycle:variant==='before'?2:1,visibleOrders:snapshot?.orders.length,mode:'Private preview, synthetic reads only'},null,2));
    }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
    finally{setRunning(false);}
  };
  return <main style={{fontFamily:'Arial,sans-serif',maxWidth:900,margin:'40px auto',padding:24}}>
    <h1>Prueba aislada de CPU de Máster</h1>
    <p>Versión: <strong>{variant==='before'?'Anterior':'Optimizada'}</strong>. Datos anonimizados. Operaciones deshabilitadas.</p>
    <p>Órdenes visibles: {snapshot?.orders.length??0}. Estado: {running?'Midiendo':ready?'Lista':'Preparando'}.</p>
    <p>Actualizaciones completas: <strong>{completed}</strong></p>
    <button disabled={!ready||running} onClick={()=>void run(20)}>Calentar 20 ciclos</button>{' '}
    <button disabled={!ready||running} onClick={()=>void run(300)}>Medir 300 ciclos</button>{' '}
    <button disabled={!ready||running} onClick={()=>void run(100)}>Medir 100 ciclos</button>
    {error&&<p role="alert">{error}</p>}
    <pre aria-label="Resultado de medición">{result||'Sin medición terminada.'}</pre>
  </main>;
}
