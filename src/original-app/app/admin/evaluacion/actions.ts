'use server';
import { requireAdminContext } from '@/lib/auth';
import { revalidatePath } from 'next/cache';
import { UUID_PATTERN } from '@/lib/rewards/wallet-model';
import { awardCalculationServer } from '@/lib/rewards/evaluation-server';
import { evaluateAwards, validateAwardPeriodRules, type AwardRules, type EvaluationInput } from '@/lib/rewards/evaluation-model';

export async function prepareAwardReview(period: string, rules: AwardRules, token: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function publishAwardReview(id: string, expectedPublished: string | null, reason: string, confirmed: boolean) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
export async function resumeAwardReview(id: string) { throw new Error('All business actions are disabled in the CPU benchmark.'); }
