'use client';
import { createContext, useContext, useActionState, useEffect, useRef, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { saveConfigurationAction, type ConfigurationState } from '@/lib/admin-config/form-actions';
const Availability = createContext(false);
export function ConfigurationAvailability({available,children}:{available:boolean;children:ReactNode}){
 return <Availability.Provider value={available}>{children}</Availability.Provider>;
}
export default function ConfigurationForm({command,id=0,children,submitLabel='Guardar'}:{command:string;id?:number;children:ReactNode;submitLabel?:string}){
 const available=useContext(Availability);
 const unavailable=['account','rules','baseline','user','new-user'].includes(command)&&!available;
 const attempt=useRef<{id:string;payload:string}|null>(null);
 const router=useRouter();
 const [state,action,pending]=useActionState(async(previous:ConfigurationState,form:FormData)=>{
  const payload=JSON.stringify(Array.from(form.entries()).filter(([key])=>!key.startsWith('$ACTION_')));
  if(!attempt.current||attempt.current.payload!==payload)attempt.current={id:crypto.randomUUID(),payload};
  form.set('operationId',attempt.current.id);
  const result=await saveConfigurationAction(previous,form);
  if(result.ok)attempt.current=null;
  return result;
 },{ok:false,message:''});
 useEffect(()=>{if(state.ok)router.refresh();},[state,router]);
 return <form action={action} className="space-y-3 text-xs">
  <input type="hidden" name="command" value={command}/><input type="hidden" name="id" value={id}/>
  {unavailable?<p role="status" className="text-xs text-orange-200">Guardado pendiente de activación segura. Puedes consultar aquí; para modificar utiliza Administrador anterior.</p>:null}
  <fieldset disabled={pending||unavailable} className="min-w-0 space-y-3">{children}<button disabled={pending||unavailable} className="min-h-11 rounded-lg bg-[#FFFF00] px-4 text-xs font-semibold text-black disabled:opacity-50">{pending?'Guardando…':submitLabel}</button></fieldset>
  {state.message?<p role={state.ok?'status':'alert'} className={state.ok?'text-emerald-200':'text-orange-200'}>{state.message}</p>:null}
 </form>;
}
