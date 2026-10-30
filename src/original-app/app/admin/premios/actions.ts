'use server';
import { revalidatePath } from 'next/cache';
import { requireAdminContext } from '@/lib/auth';
import { UUID_PATTERN, validateRewardDraft, type RewardDraftInput } from '@/lib/rewards/wallet-model';
export async function saveRewardDraftAction(input: RewardDraftInput, token: string, id?: number, version?: number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function cancelRewardDraftAction(id: number, version: number, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }

export async function issueRewardDraftAction(id: number, version: number, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function setRewardPersonalClientAction(advisorId:string,clientId:number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function lookupRewardPersonalClientAction(clientId:number) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function revokeRewardGrantAction(id: number, reason: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
