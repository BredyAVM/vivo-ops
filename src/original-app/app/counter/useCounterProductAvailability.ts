'use client';

import { useEffect, useMemo, useState } from 'react';
import { createSupabaseBrowser } from '@/lib/supabase/browser';

export type CounterProductAvailability = {
  product_id: number;
  availability_state: string;
  message: string;
  requires_master_review: boolean;
  inventory_blocks_submission: boolean;
  is_commercially_suspended?: boolean;
  protected_balance_active?: boolean;
  protected_maximum_quantity?: number | null;
  protected_available_component_units?: number | null;
};

export function isCounterProductSuspended(
  availability: CounterProductAvailability | null | undefined,
) {
  return availability?.is_commercially_suspended === true
    || availability?.availability_state === 'declared_unavailable';
}

export function useCounterProductAvailability({
  targetAt,
  productIds,
}: {
  targetAt: string | null;
  productIds: number[];
}) {
  const supabase = useMemo(() => createSupabaseBrowser(), []);
  const productIdsKey = productIds.join(',');
  const [availabilityByProductId, setAvailabilityByProductId] = useState<
    Map<number, CounterProductAvailability>
  >(new Map());
  const [availabilityLoading, setAvailabilityLoading] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  useEffect(() => {
    const requestedProductIds = productIdsKey
      .split(',')
      .map((value) => Number(value))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
      .slice(0, 200);

    if (!targetAt || requestedProductIds.length === 0) {
      setAvailabilityByProductId(new Map());
      setAvailabilityError(null);
      setAvailabilityLoading(false);
      return;
    }

    let cancelled = false;
    let requestSequence = 0;

    async function refreshAvailability() {
      const currentSequence = ++requestSequence;
      setAvailabilityLoading(true);
      const { data, error } = await supabase.rpc('inventory_catalog_availability_v1', {
        p_target_at: targetAt,
        p_product_ids: requestedProductIds,
        p_surface: 'counter_inventory',
      });
      if (cancelled || currentSequence !== requestSequence) return;

      if (error) {
        setAvailabilityError(
          'No se pudo actualizar la disponibilidad. El guardado comprobará si Máster detuvo algún producto.',
        );
      } else {
        const rows = Array.isArray(data?.products)
          ? data.products as CounterProductAvailability[]
          : [];
        setAvailabilityByProductId(
          new Map(rows.map((row) => [Number(row.product_id), row])),
        );
        setAvailabilityError(null);
      }
      setAvailabilityLoading(false);
    }

    setAvailabilityByProductId(new Map());
    void refreshAvailability();

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refreshAvailability();
    };
    const refreshWhenFocused = () => void refreshAvailability();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshAvailability();
    }, 60_000);

    document.addEventListener('visibilitychange', refreshWhenVisible);
    window.addEventListener('focus', refreshWhenFocused);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
      window.removeEventListener('focus', refreshWhenFocused);
    };
  }, [productIdsKey, supabase, targetAt]);

  return {
    availabilityByProductId,
    availabilityLoading,
    availabilityError,
  };
}
