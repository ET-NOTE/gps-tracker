// (2026-07-28) Phase F1 primitive — Button.
//
// 감사 결과: 각 파일마다 st.btnPrimary / st.btnGhost / mst.btnPrimary 반복 정의.
// 통일된 톤 · 크기 · 상태 (disabled/busy) API.
//
// 사용:
//   <Button variant="primary" onClick={..}>저장</Button>
//   <Button variant="ghost" size="sm">취소</Button>
//   <Button variant="danger" busy>삭제 중...</Button>
//   <Button variant="primary" icon={<Icon name="plus"/>} full>새 계약</Button>

const VARIANT = {
  primary: {
    background: 'var(--primary)',
    color:      'var(--primary-fg)',
    border:     'none',
  },
  ghost: {
    background: 'transparent',
    color:      'var(--text-2)',
    border:     '1px solid var(--border)',
  },
  danger: {
    background: 'var(--danger)',
    color:      '#FFF',
    border:     'none',
  },
  success: {
    background: 'var(--accent)',
    color:      '#FFF',
    border:     'none',
  },
  link: {
    background: 'transparent',
    color:      'var(--primary)',
    border:     'none',
    textDecoration: 'underline',
  },
};

const SIZE = {
  xs: { fontSize: 10, padding: 'var(--space-1) var(--space-2)' },
  sm: { fontSize: 11, padding: 'var(--space-2) var(--space-3)' },
  md: { fontSize: 13, padding: 'var(--space-2) var(--space-4)' },
  lg: { fontSize: 14, padding: 'var(--space-3) var(--space-5)' },
};

export default function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  busy = false,
  icon,
  children,
  style,
  disabled,
  ...rest
}) {
  const v = VARIANT[variant] || VARIANT.primary;
  const s = SIZE[size] || SIZE.md;
  return (
    <button
      disabled={disabled || busy}
      {...rest}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        borderRadius: 'var(--radius-sm)',
        fontWeight: 700,
        cursor: (disabled || busy) ? 'not-allowed' : 'pointer',
        opacity: (disabled || busy) ? 0.6 : 1,
        transition: 'opacity 0.15s',
        width: full ? '100%' : undefined,
        ...v,
        ...s,
        ...style,
      }}
    >
      {busy ? '⏳' : icon}
      {children}
    </button>
  );
}
