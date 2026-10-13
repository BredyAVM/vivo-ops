export const REWARD_CATEGORIES = {
  alchemist: 'Alquimista', influential: 'Influyente', strategic: 'Estratégico',
  executor: 'Ejecutor', advisor_of_month: 'Asesor del Mes', special: 'Reconocimiento especial',
} as const;
export const REWARD_MODES = { personal: 'Personal', commercial: 'Fondo comercial', flexible: 'Flexible' } as const;
export const REWARD_PURPOSES = {
  customer_gift: 'Obsequios a clientes', personal_purchase: 'Consumo propio', advisor_debt: 'Amortizar deuda del asesor',
} as const;
export type RewardCategory = keyof typeof REWARD_CATEGORIES;
export type RewardMode = keyof typeof REWARD_MODES;
export type RewardPurpose = keyof typeof REWARD_PURPOSES;
export type RewardProduct = { id: number; name: string };
export type RewardDraftInput = {
  advisorId: string; title: string; category: RewardCategory; period: string;
  kind: 'credit' | 'product_units'; mode: RewardMode; purposes: RewardPurpose[];
  amount: number; productId: number | null; productScope: 'all_products' | 'selected_products';
  allowedProductIds: number[]; expiresOn: string | null; note: string;
};
export type RewardDraft = {
  id: number; advisor_id: string; title: string; category: RewardCategory; period: string;
  kind: RewardDraftInput['kind']; mode: RewardMode; purposes: RewardPurpose[];
  amount: number | string; product_id: number | null; product_name_snapshot: string | null;
  product_scope: RewardDraftInput['productScope']; allowed_product_ids: number[];
  product_names_snapshot: string[]; expires_on: string | null; note: string;
  status: 'draft' | 'cancelled'; version: number; updated_at: string;
};
export const REWARD_DRAFT_SELECT = 'id,advisor_id,title,category,period,kind,mode,purposes,amount,product_id,product_name_snapshot,product_scope,allowed_product_ids,product_names_snapshot,expires_on,note,status,version,updated_at';
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function allowedPurposes(mode: RewardMode): RewardPurpose[] {
  if (mode === 'commercial') return ['customer_gift'];
  if (mode === 'personal') return ['personal_purchase', 'advisor_debt'];
  return ['customer_gift', 'personal_purchase', 'advisor_debt'];
}

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function validateRewardDraft(input: RewardDraftInput): string | null {
  if (!UUID_PATTERN.test(input.advisorId)) return 'Selecciona un asesor válido.';
  if (!input.title?.trim() || input.title.trim().length > 100) return 'Escribe un nombre de hasta 100 caracteres.';
  if (!Object.hasOwn(REWARD_CATEGORIES, input.category)) return 'Selecciona el reconocimiento.';
  if (!/^\d{4}-\d{2}$/.test(input.period) || !calendarDate(`${input.period}-01`)) return 'Selecciona mes y año.';
  if (!['credit', 'product_units'].includes(input.kind) || !Object.hasOwn(REWARD_MODES, input.mode)) return 'Selecciona el tipo y modalidad del premio.';
  if (!Array.isArray(input.purposes) || input.purposes.length === 0 || new Set(input.purposes).size !== input.purposes.length
    || input.purposes.some(p => !allowedPurposes(input.mode).includes(p))) return 'Selecciona usos compatibles con la modalidad.';
  if (!Number.isFinite(input.amount) || input.amount <= 0 || input.amount > 100000
    || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001) return 'Indica un monto positivo con máximo dos decimales.';
  if (input.kind === 'product_units' && (!Number.isSafeInteger(input.amount) || !Number.isSafeInteger(input.productId) || Number(input.productId) <= 0
    || input.purposes.includes('advisor_debt'))) return 'Las unidades requieren un producto, una cantidad entera y no pueden pagar deudas.';
  if (input.kind === 'credit' && input.productId !== null) return 'El crédito no lleva un producto de unidades.';
  if (!['all_products', 'selected_products'].includes(input.productScope) || !Array.isArray(input.allowedProductIds)
    || input.allowedProductIds.length > 50 || new Set(input.allowedProductIds).size !== input.allowedProductIds.length
    || input.allowedProductIds.some(id => !Number.isSafeInteger(id) || id <= 0)) return 'Selecciona hasta 50 productos válidos, sin repetir.';
  if (input.kind === 'product_units' && (input.productScope !== 'selected_products' || input.allowedProductIds.length !== 1
    || input.allowedProductIds[0] !== input.productId)) return 'El premio en unidades aplica únicamente al producto elegido.';
  if (input.productScope === 'selected_products' && input.allowedProductIds.length === 0) return 'Selecciona los productos permitidos.';
  if (input.productScope === 'all_products' && input.allowedProductIds.length !== 0) return 'Elimina la selección de productos para usar todo el catálogo.';
  if (input.expiresOn && (!calendarDate(input.expiresOn) || input.expiresOn < `${input.period}-01`)) return 'El vencimiento no puede ser anterior al mes del reconocimiento.';
  if (typeof input.note !== 'string' || input.note.trim().length > 500) return 'La nota admite hasta 500 caracteres.';
  return null;
}

export function rewardAmountLabel(reward: Pick<RewardDraft, 'kind' | 'amount' | 'product_name_snapshot'>) {
  if (reward.kind === 'product_units') return `${Number(reward.amount)} × ${reward.product_name_snapshot || 'Producto'}`;
  return new Intl.NumberFormat('es-VE', { style: 'currency', currency: 'USD' }).format(Number(reward.amount));
}

export function rewardRestrictions(reward: Pick<RewardDraft, 'purposes' | 'product_scope' | 'product_names_snapshot' | 'kind'>) {
  const uses = reward.purposes.map(p => REWARD_PURPOSES[p]).join(' · ');
  const products = reward.product_scope === 'selected_products' ? reward.product_names_snapshot.join(', ') : 'Todo el catálogo';
  return { uses, products, transferable: false, redeemableForCash: false, upgradesAllowed: false } as const;
}
