'use server';
import { requireAdminContext } from '@/lib/auth';
import * as commands from './canonical-actions';
import { revalidatePath } from 'next/cache';
import { ACCOUNT_RULE_METHODS, getPaymentMethodRolesForAccount } from '@/lib/payments/account-rule-policy';
import { requireAtomicConfiguration } from './capabilities';
export type ConfigurationState = { ok: boolean; message: string };
const roles = ['admin','master','advisor','kitchen','counter','driver'] as const;
type Role = typeof roles[number];
const currencies=['USD','VES'] as const;
const kinds=['bank','cash','fund','other','pos','wallet'] as const;
export async function saveConfigurationAction(_previous: ConfigurationState, form: FormData): Promise<ConfigurationState> { throw new Error('All business actions are disabled in the CPU benchmark.'); }
