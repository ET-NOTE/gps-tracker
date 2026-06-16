// 바텀 네비게이션 — 모바일 우선. 큰 화면에서는 가운데 정렬 + 폭 제한.
import Icon from './Icon';

const BASE_TABS = [
  { id: 'home',    label: '홈',     icon: 'home' },
  { id: 'devices', label: '단말기', icon: 'list' },
  // 운행 — seeker(패널형) / 지오펜스 등 지도-도구 패널 모음. 홈에서 분리 → 지도 가림 방지.
  { id: 'tools',   label: '운행',   icon: 'mapPin' },
  { id: 'profile', label: '내정보', icon: 'user' },
];

export default function BottomNav({ active, onChange, isAdmin, isCorporate }) {
  const tabs = [...BASE_TABS];
  if (isCorporate) tabs.push({ id: 'corporate', label: '법인',   icon: 'route' });
  if (isAdmin)     tabs.push({ id: 'admin',     label: '관리자', icon: 'wrench' });

  return (
    <nav style={s.wrap}>
      <div style={s.inner}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <button key={t.id} onClick={() => onChange(t.id)}
              className="btn-bounce fade-color"
              style={{
              ...s.btn,
              color: on ? 'var(--primary)' : 'var(--text-2)',
            }}>
              <Icon name={t.icon} size={22} stroke={on ? 2 : 1.6} />
              <div style={{ fontSize: 11, fontWeight: on ? 600 : 400, marginTop: 4 }}>{t.label}</div>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export const BOTTOM_NAV_HEIGHT = 56;

// paddingBottom 0 — Flutter SafeArea 가 bottom 도 처리.
// position+zIndex — 어떤 absolute 패널도 BottomNav 위로 못 올라오게 명시적 stacking.
const s = {
  wrap: {
    position: 'relative',
    zIndex: 20,
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    paddingBottom: 0,
    flexShrink: 0,
    backdropFilter: 'saturate(140%) blur(10px)',
  },
  inner: {
    maxWidth: 540,
    margin: '0 auto',
    height: BOTTOM_NAV_HEIGHT,
    display: 'flex',
    alignItems: 'center',
  },
  btn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    height: '100%',
    transition: 'color .15s',
  },
};
