import 'server-only';
import {revalidatePath} from 'next/cache';
export function revalidateRewardWallet() {
  revalidatePath('/app/advisor/wallet');
  revalidatePath('/app/admin/premios');
}
