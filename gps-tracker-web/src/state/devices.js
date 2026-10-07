import { api } from '../api';
import { authScope, assertSession } from '../authSession';
import { carryCacheProvenance } from '../lib/offlineCache';
import { queryClient } from './queryClient';
import { qk } from './keys';

export const EMPTY_DEVICES = [];

// The server owns membership and editable fields. Preserve only newer live
// telemetry if an HTTP snapshot was taken before a WebSocket update arrived.
export function mergeDeviceSnapshot(snapshot, current = EMPTY_DEVICES, baseline = EMPTY_DEVICES) {
  const previous = new Map(current.map(device => [device.id, device]));
  const started = new Map(baseline.map(device => [device.id, device]));
  const merged = snapshot.map(device => {
    const live = previous.get(device.id);
    if (!live) return device;
    const result = { ...device };
    const newer = key => live[key] !== started.get(device.id)?.[key] && Number.isFinite(Date.parse(live[key])) &&
      (!Number.isFinite(Date.parse(device[key])) || Date.parse(live[key]) > Date.parse(device[key]));
    if (newer('last_seen_at')) result.last_seen_at = live.last_seen_at;
    if (newer('last_fix_at')) {
      for (const key of ['last_fix_at', 'last_lat', 'last_lng']) result[key] = live[key];
    }
    return result;
  });
  return carryCacheProvenance(snapshot, merged);
}

export function deviceQueryOptions() {
  const scope = authScope(), queryKey = qk.devices();
  return {
    queryKey,
    queryFn: async ({ signal }) => {
      const baseline = queryClient.getQueryData(queryKey);
      const snapshot = await api.listDevices({ signal });
      assertSession(scope);
      return mergeDeviceSnapshot(snapshot, queryClient.getQueryData(queryKey), baseline);
    },
    // Preserve the response's offline provenance (WeakSet identity).
    structuralSharing: false,
    staleTime: 30_000,
  };
}

export function loadDeviceSnapshot() {
  return queryClient.fetchQuery({ ...deviceQueryOptions(), staleTime: 0 });
}

// Mutations must not reuse an HTTP read started before the write completed.
export async function cancelDeviceSnapshot() {
  await queryClient.cancelQueries({ queryKey: qk.devices(), exact: true });
}

export function updateDeviceList(update, scope = authScope()) {
  assertSession(scope);
  queryClient.setQueryData(qk.devices(), previous => {
    const current = previous || EMPTY_DEVICES;
    return typeof update === 'function'
      ? carryCacheProvenance(current, update(current))
      : update;
  });
}
