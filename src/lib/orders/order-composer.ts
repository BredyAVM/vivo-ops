export const EDITABLE_DETAIL_SELECTION_PREFIX = '@sel|';

export type OrderComposerComponentMode = 'fixed' | 'selectable';

export type OrderComposerProductComponent = {
  parentProductId: number;
  componentProductId: number;
  componentMode: OrderComposerComponentMode;
  quantity: number;
  countsTowardDetailLimit: boolean;
  isRequired: boolean;
  sortOrder: number;
  componentName: string;
};

export type ParsedEditableDetailLine = {
  componentName: string;
  qty: number;
  componentProductId: number | null;
};

export function isEditableDetailMetadataLine(line: string) {
  return String(line || '').trim().startsWith(EDITABLE_DETAIL_SELECTION_PREFIX);
}

export function getVisibleEditableDetailLines(lines: string[]) {
  return (lines ?? []).filter((line) => !isEditableDetailMetadataLine(line));
}

export function buildComponentDetailLines(
  components: OrderComposerProductComponent[],
  options?: {
    totalMultiplier?: number;
    selectedByProductId?: Map<number, number>;
    includeMetadata?: boolean;
  }
) {
  const totalMultiplier = Math.max(1, Number(options?.totalMultiplier || 1));
  const selectedByProductId = options?.selectedByProductId ?? new Map<number, number>();
  const detailLines: string[] = [];

  const orderedComponents = [...components].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.componentName.localeCompare(b.componentName)
  );

  for (const component of orderedComponents) {
    let componentQty = 0;

    if (component.componentMode === 'fixed' && component.isRequired) {
      componentQty = component.quantity;
    } else if (component.componentMode === 'fixed') {
      componentQty = selectedByProductId.get(component.componentProductId) ?? 0;
    } else {
      componentQty = selectedByProductId.get(component.componentProductId) ?? 0;
    }

    componentQty = Math.max(0, Number(componentQty || 0));
    if (componentQty <= 0) continue;

    const totalQty = componentQty * totalMultiplier;
    detailLines.push(`${totalQty} ${component.componentName}`);

    if (options?.includeMetadata) {
      detailLines.push(`${EDITABLE_DETAIL_SELECTION_PREFIX}${component.componentProductId}|${totalQty}`);
    }
  }

  return detailLines;
}

export function parseEditableDetailLines(lines: string[]) {
  let alias = '';
  const selections: ParsedEditableDetailLine[] = [];
  const selectionsByComponentId = new Map<number, number>();

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (!line) continue;

    if (isEditableDetailMetadataLine(line)) {
      const [, componentIdRaw, qtyRaw] = line.split('|');
      const componentProductId = Number(componentIdRaw || 0);
      const qty = Number(qtyRaw || 0);

      if (Number.isFinite(componentProductId) && componentProductId > 0 && Number.isFinite(qty) && qty > 0) {
        selectionsByComponentId.set(componentProductId, qty);
      }
      continue;
    }

    if (/^para\s*:/i.test(line)) {
      alias = line.replace(/^para\s*:/i, '').trim();
      continue;
    }

    const match = line.match(/^(\d+)\s+(.+)$/i);
    if (match) {
      const qty = Number(match[1]);
      const componentName = match[2].trim();

      if (Number.isFinite(qty) && qty > 0 && componentName) {
        selections.push({ componentName, qty, componentProductId: null });
      }
    }
  }

  if (selectionsByComponentId.size > 0) {
    return {
      alias,
      selections: Array.from(selectionsByComponentId.entries()).map(([componentProductId, qty]) => ({
        componentProductId,
        qty,
        componentName: '',
      })),
    };
  }

  return { alias, selections };
}
