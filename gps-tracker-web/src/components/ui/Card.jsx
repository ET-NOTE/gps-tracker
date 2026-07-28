// (2026-07-28) Phase F1 primitive — 표준 Card 컴포넌트.
//
// 사용:
//   <Card>...</Card>                          // 기본 (surface + border + radius-lg + space-4)
//   <Card padding="sm">...</Card>             // space-3
//   <Card padding="none">...</Card>           // 커스텀 내부 layout 용
//   <Card variant="elevated">...</Card>       // shadow-sm
//   <Card variant="ghost">...</Card>          // border 없음, 배경 surface-2
//   <Card as="button" onClick={...}>...</Card>// 클릭 가능 카드
//   <Card title="제목" actions={<Icon.../>}>...</Card>  // 헤더 라인 자동
//
// 여러 파일에 흩어진 인라인 `background: var(--surface); border: 1px solid var(--border); borderRadius: 12; padding: 12`
// 패턴 (2 파일에서 이미 자체 Card 정의) 을 이걸로 대체.

export default function Card({
  as: Tag = 'div',
  padding = 'md',
  variant = 'default',
  title,
  subtitle,
  actions,
  style,
  className,
  children,
  ...rest
}) {
  const bg =
    variant === 'ghost'    ? 'var(--surface-2)' :
    variant === 'muted'    ? 'var(--surface-2)' :
                             'var(--surface)';
  const border =
    variant === 'ghost'    ? 'none' :
    variant === 'elevated' ? 'none' :
                             '1px solid var(--border)';
  const shadow =
    variant === 'elevated' ? 'var(--shadow-sm)' :
                             'none';
  const pad =
    padding === 'none' ? 0 :
    padding === 'xs'   ? 'var(--space-2)' :
    padding === 'sm'   ? 'var(--space-3)' :
    padding === 'lg'   ? 'var(--space-5)' :
    padding === 'xl'   ? 'var(--space-6)' :
                         'var(--space-4)';   // md 기본
  const hasHeader = title != null || actions != null || subtitle != null;

  return (
    <Tag
      className={className}
      {...rest}
      style={{
        background: bg,
        border,
        borderRadius: 'var(--radius-lg)',
        padding: pad,
        boxShadow: shadow,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        color: 'var(--text)',
        textAlign: 'left',
        // as="button" 시 브라우저 기본 스타일 무시
        ...(Tag === 'button' ? { cursor: 'pointer', appearance: 'none', font: 'inherit' } : null),
        ...style,
      }}
    >
      {hasHeader && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {title && (
              <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>{title}</div>
            )}
            {subtitle && (
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>
            )}
          </div>
          {actions && <div style={{ display: 'flex', gap: 'var(--space-1)' }}>{actions}</div>}
        </div>
      )}
      {children}
    </Tag>
  );
}
