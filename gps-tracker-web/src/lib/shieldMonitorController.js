// A selection and its response always belong to the same account generation.
export function createShieldMonitorController({ api, getScope, fetchPublic, onChange, preferredId, publicView = false }) {
  let revision = 0, request = null, timeout = null, disposed = false;
  let state = { mode: 'public', devices: [], selectedId: null, data: null, error: null, loading: false, listLoading: false, fetchedAt: 0 };
  const emit = patch => { state = { ...state, ...patch }; if (!disposed) onChange(state); };
  const begin = () => {
    clearTimeout(timeout); request?.abort(); request = new AbortController();
    const version = ++revision, scope = getScope(), signal = request.signal;
    const abort = request;
    const deadline = timeout = setTimeout(() => abort.abort(), 8000);
    deadline.unref?.();
    return { signal, done: () => clearTimeout(deadline), current: () => !disposed && version === revision && scope === getScope() };
  };
  async function load() {
    if (disposed) return;
    if (state.mode === 'owned' && state.selectedId == null) return;
    const job = begin(), selected = state.selectedId;
    emit({ loading: true, error: null });
    try {
      const data = state.mode === 'public' ? await fetchPublic(job.signal) : await api.getShieldStatus(selected, job.signal);
      if (!job.current()) return;
      if (!Array.isArray(data?.items) || !Number.isFinite(Date.parse(data.server_now))) throw new Error('invalid response');
      emit({ data, fetchedAt: Date.now() });
    } catch (error) {
      if (!job.current()) return;
      if ([401, 403, 404].includes(error.status)) {
        emit({ data: null, selectedId: null, devices: state.devices.filter(d => d.id !== selected), error: '장치 소유권을 확인할 수 없습니다. 목록을 새로고침해 주세요.' });
      } else {
        emit({ error: '수신 기록을 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해 주세요.' });
      }
    } finally { job.done(); if (job.current()) emit({ loading: false }); }
  }
  async function refreshDevices() {
    if (disposed) return;
    const previous = state.selectedId ?? preferredId;
    const job = begin(), mode = publicView || getScope() === 'anonymous' ? 'public' : 'owned';
    emit({ mode, data: null, devices: [], selectedId: null, error: null, loading: false, listLoading: mode === 'owned' });
    if (mode === 'public') return load();
    try {
      const devices = await api.listShieldDevices(job.signal);
      if (!job.current()) return;
      if (!Array.isArray(devices)) throw new Error('invalid device list');
      const selectedId = devices.some(d => d.id === previous) ? previous : devices[0]?.id ?? null;
      emit({ devices, selectedId, listLoading: false });
      if (selectedId != null) return load();
    } catch (error) {
      if (job.current()) emit({ listLoading: false, error: '내 쉴드 목록을 불러오지 못했습니다. 다시 시도해 주세요.' });
    } finally { job.done(); }
  }
  function select(id) {
    if (disposed) return;
    if (state.mode !== 'owned' || !state.devices.some(d => d.id === id)) return;
    emit({ selectedId: id, data: null, error: null });
    return load();
  }
  return {
    refreshDevices, select,
    refresh: () => state.mode === 'owned' && state.selectedId == null ? refreshDevices() : load(),
    dispose() { disposed = true; ++revision; clearTimeout(timeout); request?.abort(); },
  };
}
