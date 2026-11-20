// 라이트/다크 테마 + CSS 변수.
// HTML <html data-theme="light|dark"> 로 상태 표시.
// 우선순위: userPrefs.theme (서버 sync) > localStorage (부트 seed / offline) > OS prefers.
// localStorage 는 flash 방지용 seed 로 유지 — 재로드 시 서버 응답 오기 전에도 사용자 취향 반영.

import { api } from './api';
import { useSyncExternalStore } from 'react';

// (F0-5) spacing / radius / shadow 토큰 — 테마 무관 공통.
// 하드코딩된 padding·borderRadius·boxShadow 를 codemod 로 점진 대체 예정.
// 사용: `padding: 'var(--space-3)'`, `borderRadius: 'var(--radius-md)'`
export const DESIGN_TOKENS = {
  // spacing scale (4의 배수 · Tailwind-like)
  '--space-1':  '4px',
  '--space-2':  '8px',
  '--space-3':  '12px',
  '--space-4':  '16px',
  '--space-5':  '20px',
  '--space-6':  '24px',
  '--space-8':  '32px',
  '--space-10': '40px',
  '--space-12': '48px',
  '--font-caption': '12px',
  '--font-secondary': '13px',
  '--font-body': '14px',
  '--font-title': '16px',
  '--touch-target': '44px',
  // border-radius
  '--radius-xs':  '3px',
  '--radius-sm':  '6px',
  '--radius-md':  '8px',
  '--radius-lg':  '12px',
  '--radius-xl':  '14px',
  '--radius-2xl': '16px',
  '--radius-pill': '999px',
  // shadows (라이트 기준 — 다크는 alpha 만 조정하면 대개 어울림)
  '--shadow-xs': '0 1px 2px rgba(0,0,0,0.05)',
  '--shadow-sm': '0 2px 6px rgba(0,0,0,0.08)',
  '--shadow-md': '0 4px 12px rgba(0,0,0,0.10)',
  '--shadow-lg': '0 8px 24px rgba(0,0,0,0.14)',
  // z-index scale
  '--z-modal':   '900',
  '--z-toast':   '950',
  '--z-tooltip': '1000',
};

export const THEMES = {
  light: {
    '--bg':         '#F5F5F7',   // 페이지 배경
    '--surface':    '#FFFFFF',   // 카드
    '--surface-2':  '#EDEDEF',   // 인풋 / 보조 카드
    '--border':     '#E0E0E5',
    '--text':       '#1A1A2E',
    '--text-2':     '#666',
    '--text-3':     '#686B78',
    '--primary':    '#2563EB',   // 깔끔한 블루
    '--primary-fg': '#FFFFFF',
    '--accent':     '#10B981',
    '--accent-fg':  '#071F16',
    '--danger-fg':  '#1F0808',   // 성공/상태 녹색
    '--danger':     '#EF4444',
    '--warning':    '#F59E0B',
    '--status-success-text': '#047857', '--status-success-bg': '#ECFDF5',
    '--status-warning-text': '#92400E', '--status-warning-bg': '#FFFBEB',
    '--status-danger-text': '#B91C1C', '--status-danger-bg': '#FEF2F2',
    '--status-info-text': '#1D4ED8', '--status-info-bg': '#EFF6FF',
  },
  dark: {
    '--bg':         '#0F0F1A',
    '--surface':    '#1A1A2E',
    '--surface-2':  '#0A0A12',
    '--border':     '#2A2A3E',
    '--text':       '#FFFFFF',
    '--text-2':     '#AAA',
    '--text-3':     '#A0A3B5',
    '--primary':    '#8CA2FF',   // 다크에서 더 밝은 블루
    '--primary-fg': '#0F0F1A',
    '--accent':     '#34D399',
    '--accent-fg':  '#071F16',
    '--danger-fg':  '#1F0808',
    '--danger':     '#F87171',
    '--warning':    '#FBBF24',
    '--status-success-text': '#6EE7B7', '--status-success-bg': '#12352C',
    '--status-warning-text': '#FCD34D', '--status-warning-bg': '#3C2B12',
    '--status-danger-text': '#FCA5A5', '--status-danger-bg': '#422126',
    '--status-info-text': '#BFDBFE', '--status-info-bg': '#1E304B',
  },
};

/**
 * @param {string} name  'light' | 'dark'
 * @param {object} opts
 *   - persist: localStorage 저장 여부 (기본 true). SharePage 임시 라이트 적용 시 false.
 *   - syncServer: userPrefs.theme 로 서버 push 여부 (기본 true). 로그인 안 됐으면 자동 skip.
 */
export function applyTheme(name, opts = {}) {
  const { persist = true, syncServer = true } = opts;
  name = Object.hasOwn(THEMES, name) ? name : 'dark';
  const map = THEMES[name];
  const root = document.documentElement;
  // (F0-5) 테마 무관 디자인 토큰은 매 apply 마다 재-set (idempotent) 하지만 실질 부담 없음.
  Object.entries(DESIGN_TOKENS).forEach(([k, v]) => root.style.setProperty(k, v));
  Object.entries(map).forEach(([k, v]) => root.style.setProperty(k, v));
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
