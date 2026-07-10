type AccountKind = 'bank' | 'cash' | 'fund' | 'other' | 'pos' | 'wallet';
type ClosureKind = 'bank' | 'cash' | 'pos' | 'wallet_usd' | 'retention' | 'fund' | 'other';

type MoneyAccountBalanceAccountRow = {
  id: number | string;
  currency_code: 'USD' | 'VES' | string | null;
  account_kind: AccountKind | string | null;
};

type MoneyAccountBalanceProfileRow = {
  money_account_id: number | string;
  closure_kind: ClosureKind | string | null;
};

type MoneyAccountBalanceClosureRow = {
  money_account_id: number | string;
  closure_date: string | null;
  closure_at: string | null;
  counted_amount: number | string | null;
  counted_amount_usd: number | string | null;
  created_at: string | null;
};

type MoneyAccountBalanceBaselineRow = {
  money_account_id: number | string;
  baseline_date: string | null;
  baseline_at: string | null;
  counted_amount: number | string | null;
  counted_amount_usd: number | string | null;
};

type MoneyAccountBalanceMovementRow = {
  money_account_id: number | string;
  direction: 'inflow' | 'outflow' | string | null;
  amount: number | string | null;
  amount_usd_equivalent: number | string | null;
  movement_date: string | null;
  confirmed_at: string | null;
  created_at: string | null;
};

type MoneyAccountBalanceAnchor = {
  kind: 'closure' | 'baseline' | 'none';
  date: string | null;
  at: string | null;
  amount: number;
  amountUsd: number;
  usesDailyCutoff: boolean;
};

export type MoneyAccountBalanceSnapshot = {
  moneyAccountId: number;
  currencyCode: 'USD' | 'VES';
  balanceNative: number;
  balanceUsd: number;
  anchorKind: 'closure' | 'baseline' | 'none';
  anchorDate: string | null;
  anchorAt: string | null;
  anchorAmount: number;
  calculatedAt: string;
};

function toSafeNumber(value: unknown, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function roundMoney(value: unknown) {
  return Math.round((toSafeNumber(value, 0) + Number.EPSILON) * 100) / 100;
}

function compareClosureRowsDesc(a: MoneyAccountBalanceClosureRow, b: MoneyAccountBalanceClosureRow) {
  const byDate = String(b.closure_date || '').localeCompare(String(a.closure_date || ''));
  if (byDate !== 0) return byDate;
  return String(b.closure_at || b.created_at || '').localeCompare(String(a.closure_at || a.created_at || ''));
}

function accountUsesDailyBalanceCutoff(accountKind: string | null | undefined, closureKind: string | null | undefined) {
  if (accountKind === 'cash' || accountKind === 'pos') return false;
  if (closureKind === 'cash' || closureKind === 'pos') return false;
  return true;
}

function movementRecordedAtMs(movement: MoneyAccountBalanceMovementRow) {
  const timestamp = movement.confirmed_at || movement.created_at;
  if (!timestamp) return null;

  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
}

function movementAffectsBalanceAfterAnchor(movement: MoneyAccountBalanceMovementRow, anchor: MoneyAccountBalanceAnchor) {
  const movementDate = String(movement.movement_date || '');
  if (!movementDate) return false;
  if (!anchor.date) return true;

  if (anchor.usesDailyCutoff) {
    return movementDate > anchor.date;
  }

  if (movementDate < anchor.date) return false;
  if (movementDate > anchor.date) return true;
  if (!anchor.at) return false;

  const recordedAtMs = movementRecordedAtMs(movement);
  if (recordedAtMs == null) return true;

  return recordedAtMs > new Date(anchor.at).getTime();
}

function normalizeAccountIds(accountIds: number[] | undefined) {
  return Array.from(
    new Set(
      (accountIds ?? [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id) && id > 0)
    )
  );
}

export async function loadMoneyAccountBalanceSnapshots(
  supabase: any,
  options: { moneyAccountIds?: number[] } = {}
): Promise<MoneyAccountBalanceSnapshot[]> {
  const filteredAccountIds = normalizeAccountIds(options.moneyAccountIds);

  let accountsQuery = supabase
    .from('money_accounts')
    .select('id, currency_code, account_kind')
    .order('id', { ascending: true });
  let profilesQuery = supabase
    .from('money_account_closure_profiles')
    .select('money_account_id, closure_kind')
    .order('money_account_id', { ascending: true });
  let closuresQuery = supabase
    .from('money_account_closures')
    .select('money_account_id, closure_date, closure_at, counted_amount, counted_amount_usd, created_at')
    .in('status', ['recorded', 'approved'])
    .order('closure_date', { ascending: false })
    .order('closure_at', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500);
  let baselinesQuery = supabase
    .from('money_account_closure_baselines')
    .select('money_account_id, baseline_date, baseline_at, counted_amount, counted_amount_usd')
    .eq('status', 'active')
    .order('baseline_at', { ascending: false });

  if (filteredAccountIds.length > 0) {
    accountsQuery = accountsQuery.in('id', filteredAccountIds);
    profilesQuery = profilesQuery.in('money_account_id', filteredAccountIds);
    closuresQuery = closuresQuery.in('money_account_id', filteredAccountIds);
    baselinesQuery = baselinesQuery.in('money_account_id', filteredAccountIds);
  }

  const [accountsResult, profilesResult, closuresResult, baselinesResult] = await Promise.all([
    accountsQuery,
    profilesQuery,
    closuresQuery,
    baselinesQuery,
  ]);

  if (accountsResult.error) throw new Error(accountsResult.error.message);
  if (profilesResult.error) throw new Error(profilesResult.error.message);
  if (closuresResult.error) throw new Error(closuresResult.error.message);
  if (baselinesResult.error) throw new Error(baselinesResult.error.message);

  const accounts = (accountsResult.data ?? []) as MoneyAccountBalanceAccountRow[];
  const accountIds = accounts.map((account) => Number(account.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (accountIds.length === 0) return [];

  const profileByAccountId = new Map<number, MoneyAccountBalanceProfileRow>();
  for (const profile of (profilesResult.data ?? []) as MoneyAccountBalanceProfileRow[]) {
    profileByAccountId.set(Number(profile.money_account_id), profile);
  }

  const latestClosureByAccountId = new Map<number, MoneyAccountBalanceClosureRow>();
  for (const closure of ((closuresResult.data ?? []) as MoneyAccountBalanceClosureRow[]).sort(compareClosureRowsDesc)) {
    const accountId = Number(closure.money_account_id);
    if (!Number.isFinite(accountId) || latestClosureByAccountId.has(accountId)) continue;
    latestClosureByAccountId.set(accountId, closure);
  }

  const activeBaselineByAccountId = new Map<number, MoneyAccountBalanceBaselineRow>();
  for (const baseline of baselinesResult.data ?? []) {
    const typedBaseline = baseline as MoneyAccountBalanceBaselineRow;
    const accountId = Number(typedBaseline.money_account_id);
    if (!Number.isFinite(accountId) || activeBaselineByAccountId.has(accountId)) continue;
    activeBaselineByAccountId.set(accountId, typedBaseline);
  }

  const anchorByAccountId = new Map<number, MoneyAccountBalanceAnchor>();
  const anchorDates: string[] = [];

  for (const account of accounts) {
    const accountId = Number(account.id);
    const profile = profileByAccountId.get(accountId) ?? null;
    const usesDailyCutoff = accountUsesDailyBalanceCutoff(
      String(account.account_kind || ''),
      profile?.closure_kind == null ? null : String(profile.closure_kind)
    );
    const closure = latestClosureByAccountId.get(accountId) ?? null;

    if (closure) {
      const anchor: MoneyAccountBalanceAnchor = {
        kind: 'closure',
        date: closure.closure_date,
        at: closure.closure_at || closure.created_at,
        amount: roundMoney(closure.counted_amount),
        amountUsd: roundMoney(closure.counted_amount_usd),
        usesDailyCutoff,
      };
      anchorByAccountId.set(accountId, anchor);
      if (anchor.date) anchorDates.push(anchor.date);
      continue;
    }

    const baseline = activeBaselineByAccountId.get(accountId) ?? null;
    if (baseline) {
      const anchor: MoneyAccountBalanceAnchor = {
        kind: 'baseline',
        date: baseline.baseline_date,
        at: baseline.baseline_at,
        amount: roundMoney(baseline.counted_amount),
        amountUsd: roundMoney(baseline.counted_amount_usd),
        usesDailyCutoff: true,
      };
      anchorByAccountId.set(accountId, anchor);
      if (anchor.date) anchorDates.push(anchor.date);
      continue;
    }

    anchorByAccountId.set(accountId, {
      kind: 'none',
      date: null,
      at: null,
      amount: 0,
      amountUsd: 0,
      usesDailyCutoff,
    });
  }

  const minimumAnchorDate = anchorDates.sort((a, b) => a.localeCompare(b))[0] ?? null;
  const movementDeltas = new Map<number, { native: number; usd: number }>();
  const accountIdsWithAnchor = accountIds.filter((accountId) => {
    const anchor = anchorByAccountId.get(accountId) ?? null;
    return Boolean(anchor?.date);
  });
  const accountIdsWithoutAnchor = accountIds.filter((accountId) => {
    const anchor = anchorByAccountId.get(accountId) ?? null;
    return !anchor?.date;
  });

  const applyMovementDeltas = (movements: MoneyAccountBalanceMovementRow[]) => {
    for (const movement of movements) {
      const accountId = Number(movement.money_account_id);
      const anchor = anchorByAccountId.get(accountId) ?? null;
      if (!anchor) continue;
      if (!movementAffectsBalanceAfterAnchor(movement, anchor)) continue;

      const current = movementDeltas.get(accountId) ?? { native: 0, usd: 0 };
      const signed = movement.direction === 'inflow' ? 1 : -1;
      current.native += signed * toSafeNumber(movement.amount, 0);
      current.usd += signed * toSafeNumber(movement.amount_usd_equivalent, 0);
      movementDeltas.set(accountId, current);
    }
  };

  if (minimumAnchorDate && accountIdsWithAnchor.length > 0) {
    const anchoredMovementsResult = await supabase
      .from('money_movements')
      .select('money_account_id, direction, amount, amount_usd_equivalent, movement_date, confirmed_at, created_at')
      .eq('status', 'confirmed')
      .in('money_account_id', accountIdsWithAnchor)
      .gte('movement_date', minimumAnchorDate)
      .limit(20000);

    if (anchoredMovementsResult.error) throw new Error(anchoredMovementsResult.error.message);
    applyMovementDeltas((anchoredMovementsResult.data ?? []) as MoneyAccountBalanceMovementRow[]);
  }

  if (accountIdsWithoutAnchor.length > 0) {
    const unanchoredMovementsResult = await supabase
      .from('money_movements')
      .select('money_account_id, direction, amount, amount_usd_equivalent, movement_date, confirmed_at, created_at')
      .eq('status', 'confirmed')
      .in('money_account_id', accountIdsWithoutAnchor)
      .limit(20000);

    if (unanchoredMovementsResult.error) throw new Error(unanchoredMovementsResult.error.message);
    applyMovementDeltas((unanchoredMovementsResult.data ?? []) as MoneyAccountBalanceMovementRow[]);
  }

  const calculatedAt = new Date().toISOString();

  return accounts.map((account) => {
    const accountId = Number(account.id);
    const anchor = anchorByAccountId.get(accountId) ?? {
      kind: 'none' as const,
      date: null,
      at: null,
      amount: 0,
      amountUsd: 0,
      usesDailyCutoff: true,
    };
    const delta = movementDeltas.get(accountId) ?? { native: 0, usd: 0 };
    const currencyCode = String(account.currency_code || '').toUpperCase() === 'VES' ? 'VES' : 'USD';

    return {
      moneyAccountId: accountId,
      currencyCode,
      balanceNative: roundMoney(anchor.amount + delta.native),
      balanceUsd: roundMoney(anchor.amountUsd + delta.usd),
      anchorKind: anchor.kind,
      anchorDate: anchor.date,
      anchorAt: anchor.at,
      anchorAmount: anchor.amount,
      calculatedAt,
    };
  });
}
