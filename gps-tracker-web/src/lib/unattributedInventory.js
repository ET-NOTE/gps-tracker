export const inventoryCategories = { l80: 'GPS 모듈', lte_gnss: '통신 모듈 측위', phone: '휴대전화', wake: '기상', sleep_enter: '절전 진입', other: '기타·확인 필요' };
export const inventoryLinks = { linked: '현재 계정에 연결됨', unlinked: '현재 연결 계정 없음', device_missing: '장치 정보 없음' };

export function inventoryFilters({ kind, start, end, device }) {
  const day = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Error('시작일과 종료일을 선택해 주세요.');
    const t = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== value) throw Error('올바른 날짜를 선택해 주세요.');
    return t;
  };
  const first = day(start), last = day(end);
  if (last < first || last - first >= 31 * 86400000) throw Error('조회 기간은 시작일과 종료일을 포함해 최대 31일입니다.');
  if (!['location', 'event'].includes(kind)) throw Error('자료 종류를 선택해 주세요.');
  const value = device.trim();
  if (value && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) throw Error('장치 번호는 양의 정수로 입력해 주세요.');
  return { kind, from: new Date(first - 9 * 3600000).toISOString(), until: new Date(last + 15 * 3600000).toISOString(), ...(value ? { device_id: value } : {}), limit: 50 };
}

export function recentInventoryDates(now = new Date()) {
  const end = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const start = new Date(Date.parse(end + 'T00:00:00Z') - 6 * 86400000).toISOString().slice(0, 10);
  return { start, end };
}
