'use client';

import { useEffect } from 'react';

export default function KitchenPwaRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    void navigator.serviceWorker.register('/vivo-sw.js', {
      scope: '/app/',
      updateViaCache: 'none',
    });
  }, []);

  return null;
}
