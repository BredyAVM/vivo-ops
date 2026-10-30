// Tab-local recovery only; never store credentials or bank attachments.
// User-scoped keys prevent another signed-in operator recovering this draft.
export type AttemptScope='reconciliation'|'closure'|'transfer'|'movement';
const key=(userId:string,scope:AttemptScope)=>`vivo:financial-attempt:v1:${userId}:${scope}`;
export function saveFinancialAttempt(userId:string,scope:AttemptScope,input:unknown) {
  const prior=readFinancialAttempt<{requestId:string}>(userId,scope);
  const next=input as {requestId?:string};
  if(prior && prior.requestId!==next.requestId)throw new Error('Primero comprueba el envío anterior.');
  sessionStorage.setItem(key(userId,scope),JSON.stringify(input));
}
export function clearFinancialAttempt(userId:string,scope:AttemptScope) { sessionStorage.removeItem(key(userId,scope)); }
export function readFinancialAttempt<T>(userId:string,scope:AttemptScope):T|null {
  const raw=sessionStorage.getItem(key(userId,scope)); if(!raw) return null;
  const value=JSON.parse(raw); if(!value||typeof value!=='object'||typeof value.requestId!=='string') throw new Error('No se pudo recuperar el envío pendiente. Revisa el historial antes de registrar otro.');
  return value as T;
}
