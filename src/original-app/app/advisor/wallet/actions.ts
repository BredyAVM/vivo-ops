'use server';
import {revalidatePath} from 'next/cache';
import {requireAuthContext} from '@/lib/auth';
import {UUID_PATTERN} from '@/lib/rewards/wallet-model';
export async function applyRewardDebtAction(grantId:number,closureId:number,amount:number,token:string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
