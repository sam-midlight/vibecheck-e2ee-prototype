'use client';

import { useEffect, useState } from 'react';

const STORAGE_KEY = 'vibecheck_dev_mode';

export function useDevMode(): [boolean, (v: boolean) => void] {
  const [devMode, setDevModeState] = useState(false);

  useEffect(() => {
    setDevModeState(localStorage.getItem(STORAGE_KEY) === '1');
  }, []);

  function setDevMode(v: boolean) {
    if (v) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
    setDevModeState(v);
  }

  return [devMode, setDevMode];
}
