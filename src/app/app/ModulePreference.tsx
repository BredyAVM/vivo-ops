'use client';

import { useEffect } from 'react';
import type { AppModuleKey } from '@/lib/app-modules';

type ModulePreferenceProps = {
  moduleKey: AppModuleKey;
};

const LAST_MODULE_STORAGE_KEY = 'vivo:last-module';

export function ModulePreference({ moduleKey }: ModulePreferenceProps) {
  useEffect(() => {
    window.localStorage.setItem(LAST_MODULE_STORAGE_KEY, moduleKey);
  }, [moduleKey]);

  return null;
}

export { LAST_MODULE_STORAGE_KEY };
