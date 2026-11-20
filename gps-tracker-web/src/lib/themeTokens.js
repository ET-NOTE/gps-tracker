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

export const themeProperties = name => ({ ...DESIGN_TOKENS, ...THEMES[name] });
