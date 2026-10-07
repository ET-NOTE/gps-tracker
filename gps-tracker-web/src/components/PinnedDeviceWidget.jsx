import { ageString } from '../colors';
import Icon from './Icon';
import { liveMotion } from '../lib/liveMotion';

export default function PinnedDeviceWidget({ device, deviceColor, deviceMeta, deviceStatus, onPress, onUnpin, bottomOffset = 0 }) {
  if (!device) return null;

  const speed = liveMotion(deviceMeta?.speedKmh,deviceMeta?.recordedAt).speedKmh;
  const name = device.display_name || device.device_uid;
  const isOnline = deviceStatus?.label === '활성';

  return (
    <div style={{
      position: 'absolute',
      bottom: bottomOffset + 14,
      left: 14, right: 88, maxWidth: 360,
      zIndex: 20,
      pointerEvents: 'auto',
    }}>
      <div
        onClick={onPress}
        style={{
          background: 'var(--surface)',
          border: '0.5px solid var(--border)',
          borderLeft: `4px solid ${deviceColor || '#6366f1'}`,
          borderRadius: 14,
          padding: '10px 12px',
          display: 'flex', alignItems: 'center', gap: 10,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Status dot */}
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: deviceColor ? deviceColor + '18' : '#6366f118',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon name="mapPin" size={18} style={{ color: deviceColor || '#6366f1' }} />
        </div>

        {/* Info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 7, height: 7, borderRadius: '50%',
              background: isOnline ? '#22c55e' : '#9ca3af',
              flexShrink: 0,
              boxShadow: isOnline ? '0 0 6px #22c55e' : 'none',
            }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, display: 'flex', gap: 8 }}>
            <span>{ageString(device.last_seen_at)}</span>
            {deviceMeta?.vbatMv && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <Icon name="battery" size={10} /> {deviceMeta.vbatMv}mV
              </span>
            )}
            {speed != null && (
              <span>{speed.toFixed(0)} km/h</span>
            )}
          </div>
        </div>

        {/* Unpin button */}
        <button
          onClick={e => { e.stopPropagation(); onUnpin?.(); }}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-3)', padding: 4, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}
          title="고정 해제"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}
