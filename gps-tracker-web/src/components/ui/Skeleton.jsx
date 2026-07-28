// (2026-07-28) Phase F1 primitive — Skeleton (로딩 placeholder).
//
// 감사 결과: "로딩 중..." 텍스트가 11 파일. Skeleton 은 DeviceDetail.jsx:1042 skeletonH 만 존재.
// 이걸로 통일 → 다음 라운드부터 각 로딩 텍스트 자리에 삽입.
//
// 사용:
//   <Skeleton width={120} height={16} />         // 라인
//   <Skeleton variant="circle" size={40} />       // 원형 (아바타)
//   <Skeleton variant="card" height={80} />       // 카드형
//   <SkeletonText lines={3} />                    // 텍스트 여러 줄
//   <SkeletonList count={5} />                    // 리스트 아이템 스켈레톤

const pulseAnim = `@keyframes ui-skel-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}`;

// index.css 에 이미 없으면 head 에 주입 (idempotent)
let injected = false;
function ensureAnim() {
  if (injected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.textContent = pulseAnim;
  document.head.appendChild(s);
  injected = true;
}

export default function Skeleton({
  width = '100%',
  height = 12,
  size,              // circle 인 경우 지름
  radius,
  variant = 'line',  // line | circle | card
  style,
}) {
  ensureAnim();
  const isCircle = variant === 'circle';
  const isCard   = variant === 'card';
  const w = isCircle ? (size ?? 32) : width;
  const h = isCircle ? (size ?? 32) : (isCard ? (height ?? 80) : height);
  const br = radius ?? (isCircle ? '50%' : isCard ? 'var(--radius-lg)' : 'var(--radius-sm)');
  return (
    <div
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: w, height: h,
        background: 'var(--surface-2)',
        borderRadius: br,
        animation: 'ui-skel-pulse 1.4s ease-in-out infinite',
        ...style,
      }}
    />
  );
}

export function SkeletonText({ lines = 3, gap = 'var(--space-2)', style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap, ...style }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} height={12} width={i === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export function SkeletonList({ count = 4, itemHeight = 64, style }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', ...style }}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} variant="card" height={itemHeight} />
      ))}
    </div>
  );
}
