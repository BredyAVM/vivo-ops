export const COMPANY_DOCUMENT_FIELDS = [
  'invoiceCompanyName', 'invoiceTaxId', 'invoiceAddress', 'invoicePhone',
  'deliveryNoteName', 'deliveryNoteDocumentId', 'deliveryNoteAddress', 'deliveryNotePhone',
] as const;

export type CompanyDocumentData = Record<typeof COMPANY_DOCUMENT_FIELDS[number], string>;
export type ClientCompanyProfile = {
  id: string;
  client_id: number;
  label: string;
  data: CompanyDocumentData;
  is_default: boolean;
  version: number;
};

export function normalizeCompanyDocumentData(value: Partial<CompanyDocumentData>): CompanyDocumentData {
  return Object.fromEntries(COMPANY_DOCUMENT_FIELDS.map(key => [key, String(value[key] ?? '').trim()])) as CompanyDocumentData;
}

export function companyDocumentSignature(value: Partial<CompanyDocumentData>) {
  return JSON.stringify(normalizeCompanyDocumentData(value));
}

// Never replace a draft, historical snapshot, or text entered while the list was loading.
export function canApplyDefaultCompany(autoSelect: boolean, initial: string, current: string) {
  return autoSelect && initial === current;
}
