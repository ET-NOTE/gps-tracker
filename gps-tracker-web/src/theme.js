// 라이트/다크 테마 + CSS 변수.
// HTML <html data-theme="light|dark"> 로 상태 표시.
// 우선순위: userPrefs.theme (서버 sync) > localStorage (부트 seed / offline) > OS prefers.
// localStorage 는 flash 방지용 seed 로 유지 — 재로드 시 서버 응답 오기 전에도 사용자 취향 반영.

import { api } from './api';
import { useSyncExternalStore } from 'react';

import { THEMES, themeProperties } from './lib/themeTokens.js';
export { DESIGN_TOKENS, THEMES } from './lib/themeTokens.js';

/**
 * @param {string} name  'light' | 'dark'
 * @param {object} opts
 *   - persist: localStorage 저장 여부 (기본 true). SharePage 임시 라이트 적용 시 false.
 *   - syncServer: userPrefs.theme 로 서버 push 여부 (기본 true). 로그인 안 됐으면 자동 skip.
 */
export function applyTheme(name, opts = {}) {
  const { persist = true, syncServer = true } = opts;
  name = Object.hasOwn(THEMES, name) ? name : 'dark';
  const root = document.documentElement;
  Object.entries(themeProperties(name)).forEach(([k,v]) => root.style.setProperty(k, v));
  root.setAttribute('data-theme', name);
  root.style.colorScheme = name;
  if (persist) { try { localStorage.setItem('theme', name); } catch { /* rendering works without storage */ } }
  window.dispatchEvent(new Event('gps-theme-changed'));
  if (syncServer && hasAuth()) {
    api.patchMyPrefs({ theme: name }).catch(() => { /* offline OK */ });
  }
}

function hasAuth() {
  try {
    return !!(localStorage.getItem('access_token') || sessionStorage.getItem('access_token'));
  } catch { return false; }
}

export function initTheme() {
  let saved;
  try { saved = localStorage.getItem('theme'); } catch { /* use OS preference */ }
  const prefers = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  // 부트 seed — 서버 patch 안 함 (아직 auth 없거나 서버 값 fetch 전).
  applyTheme(saved || prefers, { syncServer: false });
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}

function subscribeTheme(listener) {
  window.addEventListener('gps-theme-changed', listener);
  return () => window.removeEventListener('gps-theme-changed', listener);
}
export function useTheme() {
  return useSyncExternalStore(subscribeTheme, currentTheme, () => 'dark');
}
