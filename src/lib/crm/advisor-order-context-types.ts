export type AdvisorCrmOrderContext = {
  playMemberId: number;
  playName: string;
  benefitSelectionMode: 'single' | 'multiple';
  selectedPlayBenefitIds: number[];
  purchaseRequirementMode: 'none' | 'minimum_order';
  minimumOrderAmountUsd: number | null;
  client: {
    id: number;
    full_name: string;
    phone: string | null;
    client_type: string | null;
    fund_balance_usd?: number | string | null;
    recent_addresses?: unknown;
    billing_company_name?: string | null;
    billing_tax_id?: string | null;
    billing_address?: string | null;
    billing_phone?: string | null;
    delivery_note_name?: string | null;
    delivery_note_document_id?: string | null;
    delivery_note_address?: string | null;
    delivery_note_phone?: string | null;
  };
  benefits: Array<{
    playBenefitId: number;
    productId: number;
    quantity: number;
    creditUsd: number;
    name: string;
    sku: string | null;
    upgrades: Array<{
      id: number;
      productId: number;
      quantity: number;
      customerDifferenceUsd: number;
      name: string;
      sku: string | null;
    }>;
  }>;
};
