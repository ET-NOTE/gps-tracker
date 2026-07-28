// 데스크톱 좌측 사이드 레일 — 모바일 BottomNav 대체.
// home 외 탭은 토글식: 같은 탭 다시 누르면 닫힘 → 지도 단독 표시.
import Icon from './Icon';

const BASE_TABS = [
  { id: 'home',    label: '홈',     icon: 'home',   toggleable: false },
  { id: 'devices', label: '단말기', icon: 'list',   toggleable: true  },
  // 운행 — 지도+패널 도구 (seeker / 지오펜스). 데스크톱은 home 처럼 지도 노출 +
  // FAB 띄움. toggleable=false 라 같은 탭 두 번 눌러도 home 으로 안 빠짐.
  { id: 'tools',   label: '운행',   icon: 'mapPin', toggleable: false },
  { id: 'profile', label: '내정보', icon: 'user',   toggleable: true  },
];

export default function SideRail({ active, onChange, isAdmin, isCorporate, isRentcar, isDelivery }) {
  const tabs = [...BASE_TABS];
  if (isCorporate) tabs.push({ id: 'corporate', label: '법인운행', icon: 'route',  toggleable: true });
  if (isRentcar)   tabs.push({ id: 'rentcar',   label: '렌트카',   icon: 'route',  toggleable: true });
  if (isDelivery)  tabs.push({ id: 'delivery',  label: '배송',     icon: 'mapPin', toggleable: true });
  if (isAdmin)     tabs.push({ id: 'admin',     label: '관리자',   icon: 'wrench', toggleable: true });

  return (
    <nav style={s.wrap}>
      {tabs.map(t => {
        const on = t.id === active;
        return (
          <button key={t.id}
            onClick={() => {
              if (on && t.toggleable) onChange('home');
              else onChange(t.id);
            }}
            title={t.label}
            className="btn-bounce btn-hover-bg fade-color"
            style={{
              ...s.btn,
              color: on ? 'var(--primary)' : 'var(--text-2)',
              background: on ? 'var(--surface-2)' : 'transparent',
            }}>
            <Icon name={t.icon} size={20} stroke={on ? 2 : 1.6} />
            <div style={{ fontSize: 10, marginTop: 4, fontWeight: on ? 600 : 400 }}>{t.label}</div>
          </button>
        );
      })}
    </nav>
  );
}

export const SIDE_RAIL_WIDTH = 64;

const s = {
  wrap: {
    width: SIDE_RAIL_WIDTH,
    flexShrink: 0,
    background: 'var(--surface)',
    borderRight: '1px solid var(--border)',
    display: 'flex', flexDirection: 'column',
    alignItems: 'stretch',
    paddingTop: 'calc(env(safe-area-inset-top, 0) + 12px)',
    paddingBottom: 'env(safe-area-inset-bottom, 0)',
    gap: 4,
  },
  btn: {
    display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center',
    height: 60, margin: '0 6px',
    background: 'transparent', border: 'none', cursor: 'pointer',
    borderRadius: 10,
    transition: 'background .15s, color .15s',
  },
};
