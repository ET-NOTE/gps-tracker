import { useSyncExternalStore } from 'react';

// Match the phone layout only on screen. Printed reports keep their tables.
const phone = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('screen and (max-width: 600px)')
  : null;

const compactNav = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('screen and (max-width: 1000px)') : null;
function watch(query) {
  return [notify => {
    query?.addEventListener('change', notify);
    return () => query?.removeEventListener('change', notify);
  }, () => query?.matches ?? false];
}
const phoneStore = watch(phone), navStore = watch(compactNav);
export default function useCorporatePhone(layout) {
  return useSyncExternalStore(...(layout === 'navigation' ? navStore : phoneStore), () => false);
}
