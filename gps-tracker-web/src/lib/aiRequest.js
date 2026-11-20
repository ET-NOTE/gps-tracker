// A failed/lost response keeps the same ID across retries and page reloads.
// A completed request clears it so an explicit new analysis can be purchased.
export function createAnalysisRequester({ storage, uuid, send }) {
  const active = new Map();
  const pending = new Map();
  return function analyze(scope, deviceId, date) {
    const key = `gps_ai_pending:${scope}:${deviceId}:${date}`;
    if (active.has(key)) return active.get(key);
    let id = pending.get(key);
    try { id ||= storage.getItem(key); } catch { /* memory fallback */ }
    id ||= uuid();
    pending.set(key, id);
    try { storage.setItem(key, id); } catch { /* memory fallback */ }
    const task = Promise.resolve().then(() => send(deviceId, { date, request_id: id }))
      .then(result => {
        if (!result?.analysis_id || !result?.analysis?.trim()) {
          throw new Error('분석 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인해 주세요.');
        }
        pending.delete(key);
        try { storage.removeItem(key); } catch { /* memory fallback */ }
        return result;
      }).catch(error => {
        if (error.status === 410) {
          pending.delete(key);
          try { storage.removeItem(key); } catch { /* memory fallback */ }
        }
        throw error;
      }).finally(() => active.delete(key));
    active.set(key, task);
    return task;
  };
}
