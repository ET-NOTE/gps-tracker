// 라이트/다크 테마 + CSS 변수.
// HTML <html data-theme="light|dark"> 로 상태 표시.

export const THEMES = {
  light: {
    '--bg':         '#F5F5F7',   // 페이지 배경
    '--surface':    '#FFFFFF',   // 카드
    '--surface-2':  '#EDEDEF',   // 인풋 / 보조 카드
    '--border':     '#E0E0E5',
    '--text':       '#1A1A2E',
    '--text-2':     '#666',
    '--text-3':     '#999',
    '--primary':    '#3B82F6',   // 깔끔한 블루
    '--primary-fg': '#FFFFFF',
    '--accent':     '#10B981',   // 성공/상태 녹색
    '--danger':     '#EF4444',
    '--warning':    '#F59E0B',
  },
  dark: {
    '--bg':         '#0F0F1A',
    '--surface':    '#1A1A2E',
    '--surface-2':  '#0A0A12',
    '--border':     '#2A2A3E',
    '--text':       '#FFFFFF',
    '--text-2':     '#AAA',
    '--text-3':     '#666',
    '--primary':    '#5B7CFF',   // 다크에서 더 밝은 블루
    '--primary-fg': '#0F0F1A',
    '--accent':     '#34D399',
    '--danger':     '#F87171',
    '--warning':    '#FBBF24',
  },
};

export function applyTheme(name) {
  const map = THEMES[name] || THEMES.dark;
  const root = document.documentElement;
  Object.entries(map).forEach(([k, v]) => root.style.setProperty(k, v));
  root.setAttribute('data-theme', name);
  localStorage.setItem('theme', name);
}

export function initTheme() {
  const saved = localStorage.getItem('theme');
  const prefers = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || prefers);
}

export function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

export function currentTheme() {
  return document.documentElement.getAttribute('data-theme') || 'dark';
}
