import {OrdersWorkspace} from '@/bench/before-workspace';
import CpuCycleDriver from '@/bench/CpuCycleDriver';
export const dynamic='force-dynamic';
export default async function Page({searchParams}:{searchParams:Promise<{focusDate?:string}>}){
  const workspace=await OrdersWorkspace({surface:'master',searchParams});
  return <CpuCycleDriver variant="before" workspace={workspace}/>;
}
