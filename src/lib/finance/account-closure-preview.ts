import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

// Shared with the existing operational panel. Preview is informational;
// the canonical database command recalculates the final cut when saving.
type ClosureMovement = {
  direction: string; amount: number | string; amount_usd_equivalent: number | string;
  money_account_id: number; movement_type: string; movement_date: string;
  confirmed_at: string | null; created_at: string; reference_code: string | null;
};
function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value); return Number.isFinite(n) ? n : fallback;
}
function buildCaracasTimestamp(isoDate: string, timeValue: string | null | undefined) {
  const date = String(isoDate || '').trim();
  const rawTime = String(timeValue || '').trim();
  const time = /^\d{2}:\d{2}$/.test(rawTime) ? rawTime : '23:59';
  const parsed = new Date(`${date}T${time}:00-04:00`);

  if (Number.isNaN(parsed.getTime())) {
    throw new Error('La fecha y hora del cierre no son validas.');
  }

  return parsed.toISOString();
}

function getMovementRecordedAtMs(movement: {
  movement_date?: string | null;
  confirmed_at?: string | null;
  created_at?: string | null;
}) {
  const timestamp = movement.confirmed_at || movement.created_at;
  if (!timestamp) return null;

  const parsedTimestamp = new Date(timestamp);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp.getTime();
}

function accountUsesDailyBalanceCutoff(accountKind: string | null | undefined, closureKind: string | null | undefined) {
  if (accountKind === 'cash' || accountKind === 'pos') return false;
  if (closureKind === 'cash' || closureKind === 'pos') return false;
  return true;
}

function isPosClosureAccount(accountKind: string | null | undefined, closureKind: string | null | undefined) {
  return accountKind === 'pos' || closureKind === 'pos';
}

type MoneyAccountClosureReferenceRow = {
  id: number | string;
  money_account_id: number | string;
  closure_date: string | null;
  closure_at: string | null;
  created_at: string | null;
};

type MoneyAccountMovementReferenceRow = {
  money_account_id?: number | string | null;
  direction?: string | null;
  movement_type?: string | null;
  reference_code?: string | null;
};

function parseClosureReferenceId(referenceCode: unknown) {
  const match = String(referenceCode || '').trim().match(/^closure-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function isPosClosureSettlementMovement(input: {
  isPosClosure: boolean;
  movement: MoneyAccountMovementReferenceRow;
  closureById: Map<number, MoneyAccountClosureReferenceRow>;
}) {
  if (!input.isPosClosure) return false;
  if (input.movement.direction !== 'outflow') return false;
  if (input.movement.movement_type !== 'withdrawal') return false;

  const closureId = parseClosureReferenceId(input.movement.reference_code);
  if (!closureId) return false;

  const settledClosure = input.closureById.get(closureId) ?? null;
  if (!settledClosure) return false;
  return Number(settledClosure.money_account_id) === Number(input.movement.money_account_id);
}

export async function loadAccountClosurePreview(supabase: SupabaseClient, input: {
  moneyAccountId: number;
  closureDate: string;
  closureTime?: string | null;
}) {
  const moneyAccountId = Number(input.moneyAccountId || 0);
  const closureDate = String(input.closureDate || '').trim();
  const closureAt = buildCaracasTimestamp(closureDate, input.closureTime);
  const closureAtMs = new Date(closureAt).getTime();

  if (!Number.isFinite(moneyAccountId) || moneyAccountId <= 0) {
    throw new Error('Cuenta invalida.');
  }

  if (!closureDate) {
    throw new Error('Debes indicar la fecha del cierre.');
  }

  const { data: account, error: accountError } = await supabase
    .from('money_accounts')
    .select('id, currency_code, account_kind')
    .eq('id', moneyAccountId)
    .single();

  if (accountError || !account) {
    throw new Error(accountError?.message || 'No se pudo cargar la cuenta.');
  }

  const { data: profile, error: profileError } = await supabase
    .from('money_account_closure_profiles')
    .select('closure_kind')
    .eq('money_account_id', moneyAccountId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  const usesDailyCutoff = accountUsesDailyBalanceCutoff(account.account_kind, profile?.closure_kind);
  const isPosClosure = isPosClosureAccount(account.account_kind, profile?.closure_kind);

  const { data: activeBaseline, error: baselineError } = await supabase
    .from('money_account_closure_baselines')
    .select('baseline_date, baseline_at, counted_amount, counted_amount_usd')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'active')
    .maybeSingle();

  if (baselineError) throw new Error(baselineError.message);

  let previousClosureQuery = supabase
    .from('money_account_closures')
    .select('id, money_account_id, closure_date, closure_at, counted_amount, counted_amount_usd, created_at')
    .eq('money_account_id', moneyAccountId)
    .in('status', ['recorded', 'approved']);

  previousClosureQuery = usesDailyCutoff
    ? previousClosureQuery
        .lt('closure_date', closureDate)
        .order('closure_date', { ascending: false })
        .order('closure_at', { ascending: false })
        .order('created_at', { ascending: false })
    : previousClosureQuery
        .lt('closure_at', closureAt)
        .order('closure_at', { ascending: false })
        .order('created_at', { ascending: false });

  const { data: previousClosure, error: previousClosureError } = await previousClosureQuery.limit(1).maybeSingle();

  if (previousClosureError) throw new Error(previousClosureError.message);

  const closureReferences: MoneyAccountClosureReferenceRow[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from('money_account_closures')
      .select('id, money_account_id, closure_date, closure_at, created_at')
      .eq('money_account_id', moneyAccountId).in('status', ['recorded', 'approved'])
      .order('id', { ascending: true }).range(offset, offset + 999);
    if (error) throw new Error(error.message);
    closureReferences.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  const closureReferenceById = new Map<number, MoneyAccountClosureReferenceRow>();
  for (const closureReference of (closureReferences ?? []) as MoneyAccountClosureReferenceRow[]) {
    const closureId = Number(closureReference.id);
    if (Number.isFinite(closureId) && closureId > 0) {
      closureReferenceById.set(closureId, closureReference);
    }
  }

  let movementsQuery = supabase
    .from('money_movements')
    .select('money_account_id, direction, amount, amount_usd_equivalent, movement_type, movement_date, confirmed_at, created_at, reference_code')
    .eq('money_account_id', moneyAccountId)
    .eq('status', 'confirmed')
    .lte('movement_date', closureDate);

  if (previousClosure?.closure_date) {
    movementsQuery = usesDailyCutoff
      ? movementsQuery.gt('movement_date', previousClosure.closure_date)
      : movementsQuery.gte('movement_date', previousClosure.closure_date);
  } else if (activeBaseline?.baseline_date) {
    movementsQuery = movementsQuery.gt('movement_date', activeBaseline.baseline_date);
  }

  movementsQuery = movementsQuery.order('id', { ascending: true });
  const movements: ClosureMovement[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await movementsQuery.range(offset, offset + 999);
    if (error) throw new Error(error.message);
    movements.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  let expectedAmount = isPosClosure
    ? 0
    : previousClosure
      ? toSafeNumber(previousClosure.counted_amount, 0)
      : activeBaseline
        ? toSafeNumber(activeBaseline.counted_amount, 0)
        : 0;
  let expectedAmountUsd = isPosClosure
    ? 0
    : previousClosure
      ? toSafeNumber(previousClosure.counted_amount_usd, 0)
      : activeBaseline
        ? toSafeNumber(activeBaseline.counted_amount_usd, 0)
        : 0;
  const previousClosureDate = previousClosure?.closure_date ? String(previousClosure.closure_date) : null;
  const previousClosureAtMs = previousClosure?.closure_at ? new Date(previousClosure.closure_at).getTime() : null;

  for (const movement of movements ?? []) {
    const movementDate = String(movement.movement_date || '');
    const movementRecordedAtMs = getMovementRecordedAtMs(movement);

    if (movementDate > closureDate) continue;
    if (!usesDailyCutoff && movementDate === closureDate && movementRecordedAtMs != null && movementRecordedAtMs > closureAtMs) continue;
    if (previousClosureDate) {
      if (usesDailyCutoff && movementDate <= previousClosureDate) continue;
      if (movementDate < previousClosureDate) continue;
      if (
        !usesDailyCutoff &&
        movementDate === previousClosureDate &&
        previousClosureAtMs != null &&
        movementRecordedAtMs != null &&
        movementRecordedAtMs <= previousClosureAtMs
      ) {
        continue;
      }
    }

    if (
      isPosClosureSettlementMovement({
        isPosClosure,
        movement,
        closureById: closureReferenceById,
      })
    ) {
      continue;
    }

    const signed = movement.direction === 'inflow' ? 1 : -1;
    expectedAmount += signed * toSafeNumber(movement.amount, 0);
    expectedAmountUsd += signed * toSafeNumber(movement.amount_usd_equivalent, 0);
  }

  return {
    moneyAccountId,
    closureDate,
    closureAt,
    expectedAmount: Number(expectedAmount.toFixed(2)),
    expectedAmountUsd: Number(expectedAmountUsd.toFixed(2)),
    currencyCode: String(account.currency_code || '').toUpperCase(),
  };
}
