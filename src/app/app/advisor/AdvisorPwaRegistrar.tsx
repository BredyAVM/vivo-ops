'use client';

import { useEffect } from 'react';

export default function AdvisorPwaRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    void navigator.serviceWorker.register('/advisor-sw.js', {
      scope: '/app/advisor/',
      updateViaCache: 'none',
    });
  }, []);

  return null;
}
