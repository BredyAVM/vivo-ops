import { normalizePhone } from '../phone/normalize-phone.ts';

export type ClientDocumentInput = {
  hasInvoice: boolean;
  invoiceCompanyName?: string | null;
  invoiceTaxId?: string | null;
  invoiceAddress?: string | null;
  invoicePhone?: string | null;
  hasDeliveryNote: boolean;
  deliveryNoteName?: string | null;
  deliveryNoteDocumentId?: string | null;
  deliveryNoteAddress?: string | null;
  deliveryNotePhone?: string | null;
};

const clean = (value: string | null | undefined) => value?.trim() || null;

// A document omitted from this order is not a request to erase the client's profile.
export function clientDocumentProfilePatch(input: ClientDocumentInput) {
  return {
    ...(input.hasInvoice ? {
      billing_company_name: clean(input.invoiceCompanyName),
      billing_tax_id: clean(input.invoiceTaxId),
      billing_address: clean(input.invoiceAddress),
      billing_phone: normalizePhone(input.invoicePhone || '') || null,
    } : {}),
    ...(input.hasDeliveryNote ? {
      delivery_note_name: clean(input.deliveryNoteName),
      delivery_note_document_id: clean(input.deliveryNoteDocumentId),
      delivery_note_address: clean(input.deliveryNoteAddress),
      delivery_note_phone: normalizePhone(input.deliveryNotePhone || '') || null,
    } : {}),
  };
}
