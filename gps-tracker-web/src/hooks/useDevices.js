// useDevices.js — device ro'yxatini yuklash va xaritaga sync qilish hook'i.
// Dashboard.jsx dagi loadDevices / loadDevicesIncremental logikasini ajratadi.
import { useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { offlineCache } from '../lib/offlineCache';
import { syncDeviceToMap } from '../lib/deviceMapSync';

export function useDevices(mapRef) {
  const [devices, setDevices]         = useState([]);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [deviceChartData, setDeviceChartData] = useState({});
  const devRef      = useRef([]);
  const lastMetaRef = useRef({});

  /**
   * Birinchi yuklash — barcha device'lar uchun loc + history.
   * URL'dagi ?device= parametri bo'yicha avtomatik filter qo'llaydi.
   * wsRef.current?.subscribe() ni chaqirish uchun wsRef ixtiyoriy argument sifatida qabul qilinadi.
   */
  const loadDevices = useCallback(async (wsRef) => {
    try {
      const targetIdRaw = new URLSearchParams(window.location.search).get('device');
      const targetId = targetIdRaw ? parseInt(targetIdRaw, 10) : NaN;

      const list = await api.listDevices();
      let effectiveTargetId = targetId;
      if (isNaN(effectiveTargetId) && list.length > 0) {
        const mostRecent = list.reduce((a, b) => {
          const ta = a.last_seen_at ? new Date(a.last_seen_at).getTime() : 0;
          const tb = b.last_seen_at ? new Date(b.last_seen_at).getTime() : 0;
          return tb > ta ? b : a;
        });
        effectiveTargetId = mostRecent.id;
      }

      setDevices(list);
      setDevicesLoaded(true);
      devRef.current = list;
      offlineCache.saveDevices(list);
      wsRef?.current?.subscribe(list.map(d => d.id));

      const newChartData = {};
      for (const d of list) {
        const chartDays = await syncDeviceToMap(mapRef, d, lastMetaRef);
        if (chartDays) newChartData[d.id] = chartDays;
      }
      setDeviceChartData(prev => ({ ...prev, ...newChartData }));

      if (!isNaN(effectiveTargetId)) {
        mapRef.current?.filterToDevice(effectiveTargetId);
      } else {
        mapRef.current?.fitToAllMarkers(60);
      }
    } catch {
      const cached = offlineCache.loadDevices();
      if (cached?.length) {
        setDevices(cached);
        setDevicesLoaded(true);
        devRef.current = cached;
      }
    }
  }, [mapRef]);

  /**
   * Incremental yangilash — faqat yangi qo'shilgan device'larni sync qiladi.
   * O'chirilgan device'lar uchun xaritadan marker olib tashlaydi.
   */
  const loadDevicesIncremental = useCallback(async (wsRef) => {
    try {
      const list = await api.listDevices();
      const oldIds = new Set(devRef.current.map(d => d.id));
      const newIds = new Set(list.map(d => d.id));

      // O'chirilgan device'lar uchun marker tozalash
      oldIds.forEach(id => {
        if (!newIds.has(id)) {
          mapRef.current?.removeMarker(id);
          delete lastMetaRef.current[id];
        }
      });

      setDevices(list);
      devRef.current = list;
      wsRef?.current?.subscribe(list.map(d => d.id));

      // Faqat yangi device'lar uchun loc yuklash
      for (const d of list) {
        if (oldIds.has(d.id)) continue;
        const chartDays = await syncDeviceToMap(mapRef, d, lastMetaRef);
        if (chartDays) {
          setDeviceChartData(prev => ({ ...prev, [d.id]: chartDays }));
        }
      }
    } catch (e) {
      console.error('loadDevicesIncremental', e);
    }
  }, [mapRef]);

  return {
    devices,
    setDevices,
    devicesLoaded,
    devRef,
    lastMetaRef,
    deviceChartData,
    loadDevices,
    loadDevicesIncremental,
  };
}
