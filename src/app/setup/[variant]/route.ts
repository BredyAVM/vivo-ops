import {NextRequest,NextResponse} from 'next/server';

export async function GET(request:NextRequest,{params}:{params:Promise<{variant:string}>}) {
  const {variant}=await params;
  if(!['before','after'].includes(variant)||process.env.VERCEL_ENV==='production')return new Response('Not found',{status:404});
  const b64=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const user={id:'00000000-0000-4000-8000-000000000001',aud:'authenticated',role:'authenticated',email:'diagnostic@example.invalid',app_metadata:{},user_metadata:{}};
  const token=b64({alg:'HS256',typ:'JWT'})+'.'+b64({sub:user.id,aud:user.aud,role:user.role,exp:2208988800})+'.fixture';
  const session={access_token:token,refresh_token:'fixture-refresh',expires_at:2208988800,expires_in:3600,token_type:'bearer',user};
  const response=NextResponse.redirect(new URL('/app/'+variant+'?focusDate=2026-10-28',request.url));
  // This unsigned fixture cookie is valid only for the synthetic SDK setup.
  // It grants no Supabase or Vercel account access.
  response.cookies.set('sb-diagnostic-auth-token','base64-'+b64(session),{httpOnly:true,sameSite:'lax',path:'/',maxAge:3600});
  return response;
}
