// PairTutorial 표시 여부 상태 — userPrefs.pair_tutorial_seen (server sync) 우선,
// legacy localStorage 는 마이그레이션 fallback. 순환 의존 방지 위해 UI 컴포넌트에서 분리.

import { api } from './api';

const LEGACY_KEY = 'pair_tutorial_seen';

let _seenCache = null;   // null = 미hydrate, boolean = 확정

export function hydratePairTutorialSeen(v) {
  _seenCache = v == null ? null : !!v;
}

export function shouldShowPairTutorial(deviceCount, forceQuery = false) {
  if (forceQuery) return true;
  if (_seenCache === true) return false;
  if (_seenCache === null) {
    try {
      if (localStorage.getItem(LEGACY_KEY) === '1') return false;
    } catch { /* noop */ }
  }
  return deviceCount === 0;
}

export function markPairTutorialSeen() {
  _seenCache = true;
  try { localStorage.setItem(LEGACY_KEY, '1'); } catch { /* noop */ }
  api.patchMyPrefs({ pair_tutorial_seen: true }).catch(() => { /* offline OK */ });
}
