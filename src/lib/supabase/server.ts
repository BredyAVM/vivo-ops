import {headers} from 'next/headers';import {makeSupabase} from '@/bench/fixture';export async function createSupabaseServer(){const h=await headers();return makeSupabase(h.get('x-cpu-sample')||'');}
