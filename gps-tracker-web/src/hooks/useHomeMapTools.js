import { useEffect, useState } from 'react';

// One active map tool prevents two panels from owning the same map layer.
export function useHomeMapTools(view, hasDevice) {
  const [mode, setMode] = useState(null);
  const unavailable = view !== 'home' || (!hasDevice && (mode === 'mini' || mode === 'seeker'));
  useEffect(() => { if (unavailable) setMode(null); }, [unavailable]);
  const visibleMode = unavailable ? null : mode;
  return {
    showMiniSeeker: visibleMode === 'mini',
    showSeeker: visibleMode === 'seeker',
    showGeofence: visibleMode === 'geofence',
    showRoutePlanner: visibleMode === 'route',
    fullToolOpen: visibleMode != null && visibleMode !== 'mini',
    openTool: setMode,
    closeTool: () => setMode(null),
    toggleMini: () => setMode(previous => previous === 'mini' ? null : 'mini'),
  };
}
