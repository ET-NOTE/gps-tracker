// (2026-07-28) Shared dashboard stat card — 대시보드 상단 요약 타일.
// 3개 계정 유형 (corporate_fleet / rentcar / delivery) 전용 대시보드가 같은
// 룩앤필로 통일되도록 재사용. 이전엔 각 패널에 Card 가 중복 정의되고 상단 요약
// 개념 자체가 없어서 이 컴포넌트로 시작.
//
// 사용:
//   <StatCardGrid>
//     <StatCard icon="list" label="전체 차량"   value="12"  unit="대" tone="default" />
//     <StatCard icon="route" label="운행 중"    value="3"   unit="대" tone="success" />
//     <StatCard icon="mapPin" label="오늘 운행" value="248" unit="km" tone="primary" />
//     <StatCard icon="bar"  label="이번달"      value="5,342" unit="km" tone="default" />
//   </StatCardGrid>

import Icon from '../Icon';

// theme.js 의 CSS 변수 — --primary (blue), --accent (green = 상태), --danger (red), --warning (amber)
const TONE = {
  default: { valueColor: 'var(--text)',    iconBg: 'var(--surface-2)', iconColor: 'var(--text-2)' },
  primary: { valueColor: 'var(--primary)', iconBg: 'color-mix(in srgb, var(--primary) 12%, transparent)', iconColor: 'var(--primary)' },
  success: { valueColor: 'var(--accent)',  iconBg: 'color-mix(in srgb, var(--accent) 12%, transparent)',  iconColor: 'var(--accent)' },
  warn:    { valueColor: 'var(--warning)', iconBg: 'color-mix(in srgb, var(--warning) 12%, transparent)', iconColor: 'var(--warning)' },
  danger:  { valueColor: 'var(--danger)',  iconBg: 'color-mix(in srgb, var(--danger) 12%, transparent)',  iconColor: 'var(--danger)' },
};

export function StatCard({ icon, label, value, unit, tone = 'default', loading = false, hint }) {
  const t = TONE[tone] || TONE.default;
  return (
    <div style={{
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 14,
      padding: '16px 18px',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      minHeight: 96,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon && (
          <div style={{
            width: 30, height: 30,
            borderRadius: 10,
            background: t.iconBg,
            color: t.iconColor,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon name={icon} size={16} />
          </div>
        )}
        <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 600 }}>
          {label}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{
          fontSize: 28, fontWeight: 800, lineHeight: 1,
          color: t.valueColor,
          fontVariantNumeric: 'tabular-nums',
          letterSpacing: '-0.02em',
        }}>
          {loading ? '–' : value}
        </span>
        {unit && (
          <span style={{ fontSize: 13, color: 'var(--text-3)', fontWeight: 500 }}>
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: -2 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

// 반응형 그리드 — 데스크톱 4열, 태블릿 2열, 모바일 2열.
// auto-fit + minmax(140px, 1fr) 로 컨테이너 폭에 자연 적응.
export function StatCardGrid({ children }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
      gap: 12,
      marginBottom: 12,
    }}>
      {children}
    </div>
  );
}
