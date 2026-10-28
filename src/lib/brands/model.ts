export type CommercialBrandCode = 'vivo' | 'muerdeme';
export type BrandIncentivePolicy = {
  revision: number;
  firstOrderUsd: number;
  recurrentOrderUsd: number;
  requiresBurger: true;
  status: 'draft';
  createdAt: string;
};
export type CommercialBrand = {
  code: CommercialBrandCode;
  name: string;
  salesEnabled: boolean;
  incentivePolicy: BrandIncentivePolicy | null;
};
export type BrandCatalogItem = {
  id: number;
  name: string;
  isActive: boolean;
  brandCode: CommercialBrandCode;
  amount: number;
  currency: 'USD' | 'VES';
};
export type CommercialFoundation = {
  version: 'commercial-foundation-v1';
  brands: CommercialBrand[];
  catalog: BrandCatalogItem[];
  hasNext: boolean;
  page: number;
};
export type BrandFoundationFilters = {
  includeCatalog: boolean;
  brandCode: CommercialBrandCode | null;
  query: string;
  page: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('La consulta de marcas devolvió datos incompletos.');
  }
  return value as Record<string, unknown>;
}

function money(value: unknown): number {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '') {
    throw new Error('La consulta de marcas devolvió un importe inválido.');
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('La consulta de marcas devolvió un importe inválido.');
  }
  return amount;
}

export function commercialBrandCode(value: unknown): CommercialBrandCode {
  if (value === 'vivo' || value === 'muerdeme') return value;
  throw new Error('Selecciona una marca válida.');
}

export function parseBrandFoundationFilters(
  params: Record<string, string | undefined>,
): BrandFoundationFilters {
  const pageText = params.page ?? '1';
  const page = Number(pageText);
  if (!/^\d+$/.test(pageText) || !Number.isSafeInteger(page) || page < 1 || page > 10000) {
    throw new Error('Página de catálogo inválida.');
  }
  const query = (params.q ?? '').trim();
  if (query.length > 100) throw new Error('La búsqueda admite hasta 100 caracteres.');
  return {
    includeCatalog: params.catalogo === '1',
    brandCode: params.marca ? commercialBrandCode(params.marca) : null,
    query,
    page,
  };
}

/** Accept decimal comma or point, without silently rounding or interpreting thousands. */
export function parseIncentiveUsd(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,9}(?:[.,]\d{1,2})?$/.test(value.trim())) {
    throw new Error('Introduce un importe en USD con hasta dos decimales.');
  }
  const [whole, decimals = ''] = value.trim().replace(',', '.').split('.');
  return (Number(whole) * 100 + Number(decimals.padEnd(2, '0'))) / 100;
}

export function decodeCommercialFoundation(value: unknown): CommercialFoundation {
  const data = record(value);
  if (data.version !== 'commercial-foundation-v1' || !Array.isArray(data.brands)
    || !Array.isArray(data.catalog) || data.catalog.length > 25
    || typeof data.hasNext !== 'boolean' || !Number.isSafeInteger(data.page)
    || Number(data.page) < 1 || Number(data.page) > 10000) {
    throw new Error('La base de marcas no está disponible.');
  }
  const brands = data.brands.map((raw): CommercialBrand => {
    const brand = record(raw);
    if (typeof brand.name !== 'string' || !brand.name || typeof brand.salesEnabled !== 'boolean') {
      throw new Error('La consulta de marcas está incompleta.');
    }
    const code = commercialBrandCode(brand.code);
    let incentivePolicy: BrandIncentivePolicy | null = null;
    if (brand.incentivePolicy != null) {
      const policy = record(brand.incentivePolicy);
      if (code !== 'muerdeme' || !Number.isSafeInteger(policy.revision) || Number(policy.revision) < 1
        || policy.requiresBurger !== true || policy.status !== 'draft'
        || typeof policy.createdAt !== 'string' || !Number.isFinite(Date.parse(policy.createdAt))) {
        throw new Error('La configuración de estímulos está incompleta.');
      }
      const firstOrderUsd = money(policy.firstOrderUsd);
      const recurrentOrderUsd = money(policy.recurrentOrderUsd);
      for (const amount of [firstOrderUsd, recurrentOrderUsd]) {
        if (amount >= 1e9 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.0001) {
          throw new Error('La configuración de estímulos tiene un importe inválido.');
        }
      }
      incentivePolicy = {
        revision: Number(policy.revision), firstOrderUsd, recurrentOrderUsd,
        requiresBurger: true, status: 'draft', createdAt: policy.createdAt,
      };
    }
    if (code === 'muerdeme' && incentivePolicy === null) {
      throw new Error('Falta la configuración de estímulos de Muérdeme.');
    }
    return { code, name: brand.name, salesEnabled: brand.salesEnabled, incentivePolicy };
  });
  if (brands.length !== 2 || new Set(brands.map(brand => brand.code)).size !== 2) {
    throw new Error('La base de marcas está incompleta.');
  }
  const catalog = data.catalog.map((raw): BrandCatalogItem => {
    const item = record(raw);
    if (!Number.isSafeInteger(item.id) || Number(item.id) <= 0
      || typeof item.name !== 'string' || !item.name || typeof item.isActive !== 'boolean'
      || (item.currency !== 'USD' && item.currency !== 'VES')) {
      throw new Error('La consulta del catálogo está incompleta.');
    }
    return {
      id: Number(item.id), name: item.name, isActive: item.isActive,
      brandCode: commercialBrandCode(item.brandCode), amount: money(item.amount), currency: item.currency,
    };
  });
  return { version: 'commercial-foundation-v1', brands, catalog, hasNext: data.hasNext, page: Number(data.page) };
}
