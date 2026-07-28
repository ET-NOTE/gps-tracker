// (2026-07-28) Phase F1 primitive — Pill (상태 뱃지).
//
// 감사 결과: 각 파일에서 `padding: '2px 6px' borderRadius: 999 background: color-mix(...)` 반복.
// RentcarPanel RENTAL_STATUS · CorporatePanel RESV_STATUS · Dashboard 등에서 통일.
//
// 사용:
//   <Pill tone="success">임대중</Pill>
//   <Pill tone="danger" size="xs">⛔ 차단</Pill>
//   <Pill tone="warning" solid>연체</Pill>       // solid = 배경 채움
//   <Pill color="#5B7CFF">커스텀</Pill>          // owner-brand 색

const TONE_COLOR = {
  default: 'var(--text-2)',
  primary: 'var(--primary)',
  success: 'var(--accent)',
  danger:  'var(--danger)',
  warning: 'var(--warning)',
  muted:   'var(--text-3)',
};

const SIZE_STYLE = {
  xs: { fontSize: 10, padding: '2px 6px' },
  sm: { fontSize: 11, padding: '3px 8px' },
  md: { fontSize: 12, padding: '4px 10px' },
};

export default function Pill({
  tone = 'default',
  size = 'sm',
  solid = false,
  color,
  children,
  style,
  onClick,
  title,
}) {
  const c = color || TONE_COLOR[tone] || TONE_COLOR.default;
  const bg = solid
    ? c
    : `color-mix(in srgb, ${c} 15%, transparent)`;
  const fg = solid
    ? 'var(--primary-fg)'   // solid 뱃지는 dark-on-color 대비 위해 primary-fg 재사용
    : c;
  return (
    <span
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        borderRadius: 'var(--radius-pill)',
        fontWeight: 700,
        color: fg,
        background: bg,
        whiteSpace: 'nowrap',
        cursor: onClick ? 'pointer' : 'default',
        ...SIZE_STYLE[size],
        ...style,
      }}
    >{children}</span>
  );
}
