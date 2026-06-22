// useGeofences.js — geofence ro'yxati va notification settings hook'i.
import { useState, useCallback } from 'react';
import { api } from '../api';

export function useGeofences() {
  const [fences, setFences]                 = useState([]);
  const [geofenceAlert, setGeofenceAlertRaw] = useState(true);
  const [showFences, setShowFencesRaw]       = useState(
    () => localStorage.getItem('show_fences') !== 'false'
  );

  const loadFences = useCallback(async () => {
    try {
      setFences(await api.listGeofences());
    } catch (e) {
      console.error('loadFences', e);
    }
  }, []);

  const loadGeofenceAlert = useCallback(async () => {
    try {
      const s = await api.getNotificationSettings();
      setGeofenceAlertRaw(!!s.geofence_alert);
    } catch {
      // default true saqlanadi
    }
  }, []);

  const toggleGeofenceAlert = useCallback(async (v) => {
    setGeofenceAlertRaw(v); // optimistic
    try {
      await api.updateNotificationSettings({ geofence_alert: v });
    } catch (e) {
      setGeofenceAlertRaw(!v);
      alert(e.message || '알림 설정 변경 실패');
    }
  }, []);

  const setShowFences = useCallback((v) => {
    setShowFencesRaw(prev => {
      const next = typeof v === 'function' ? v(prev) : v;
      localStorage.setItem('show_fences', String(next));
      api.patchMyPrefs({ show_fences: next }).catch(() => {});
      return next;
    });
  }, []);

  return {
    fences,
    setFences,
    loadFences,
    showFences,
    setShowFences,
    geofenceAlert,
    setGeofenceAlertRaw,
    loadGeofenceAlert,
    toggleGeofenceAlert,
  };
}
