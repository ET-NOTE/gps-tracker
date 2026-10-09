import { businessDate, rentalStatus, vehicleName } from './business.js';

export const purposeLabel = { business: '업무', commute: '출퇴근', other: '기타', unspecified: '미지정' };
const statusLabel = { draft: '초안', active: '임대 중', overdue: '반납 지연', returned: '반납 완료', cancelled: '취소' };
const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const money = value => value == null ? '' : num(value);
export const kstDateTime = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '';
  return new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
};
const column = (key, label, numeric = false) => ({ key, label, numeric });

// Shared by the visible table and every export; exporting cannot silently drop a filter.
export function filterTrips(trips, { driver = 'all', purpose = 'all', minHours = '' } = {}) {
  const minutes = Math.max(0, num(minHours) * 60);
  return trips.filter(t => (driver === 'all' || (driver === 'unassigned'
    ? t.annotation?.driver_staff_id == null : String(t.annotation?.driver_staff_id) === String(driver)))
    && (purpose === 'all' || (t.annotation?.purpose || 'unspecified') === purpose)
    && num(t.duration_min) >= minutes);
}

export function rentalPeriod(contracts, { from, to, kind }) {
  const start = new Date(`${from}T00:00:00+09:00`).getTime();
  const end = new Date(`${to}T00:00:00+09:00`).getTime() + 86400000;
  return contracts.filter(c => kind === 'settled'
    ? c.status === 'returned' && new Date(c.settled_at).getTime() >= start && new Date(c.settled_at).getTime() < end
    : new Date(c.starts_at).getTime() < end && new Date(c.ends_at).getTime() > start);
}
export function monthDateBounds(ym) {
  const [year,month] = ym.split('-').map(Number);
  return {from:`${ym}-01`,to:new Date(Date.UTC(year,month,0)).toISOString().slice(0,10)};
}

export function tripReport(trips, { device, info, from, to, filterText = '' }) {
  const rows = trips.map(t => ({
    start: kstDateTime(t.started_at), end: kstDateTime(t.ended_at) || '운행 중',
    minutes: money(t.duration_min), purpose: purposeLabel[t.annotation?.purpose || 'unspecified'],
    origin: t.start_address || coordinates(t.start_lat, t.start_lng),
    destination: t.end_address || coordinates(t.end_lat, t.end_lng),
    originCoord: coordinates(t.start_lat,t.start_lng), destinationCoord: coordinates(t.end_lat,t.end_lng),
    km: Number((num(t.distance_m) / 1000).toFixed(2)),
    driver: t.annotation?.driver_name || '미지정', liters: money(t.annotation?.fuel_liters),
    fuel: money(t.annotation?.fuel_cost), note: [t.annotation?.purpose_note, t.annotation?.note].filter(Boolean).join(' / '),
  }));
  return { title: '법인 차량 운행일지', filename: `법인차_운행일지_${vehicleName(device || {})}_${from}_${to}`,
    meta: [info?.company_name, `차량: ${vehicleName(device || {})}`, `기간: ${from} ~ ${to} (한국 시간)`, filterText].filter(Boolean),
    summary: `${rows.length}건 · 총 ${(trips.reduce((s,t) => s + num(t.distance_m), 0) / 1000).toFixed(2)} km`,
    columns: [column('start','출발 일시'),column('end','도착 일시'),column('minutes','운행(분)',true),column('purpose','용무'),column('origin','출발지'),{...column('originCoord','출발 좌표'),pdf:false},column('destination','도착지'),{...column('destinationCoord','도착 좌표'),pdf:false},column('km','거리(km)',true),column('driver','운전자'),column('liters','유류(L)',true),column('fuel','유류비(원)',true),column('note','메모')], rows };
}
function coordinates(lat,lng) { return lat == null || lng == null ? '' : `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`; }

export function rentalReport(contracts, { settlement = false, filterText = '', now = Date.now() } = {}) {
  const selected = settlement ? contracts.filter(c => c.status === 'returned') : contracts;
  const rows = selected.map(c => ({
    id: c.id, vehicle: c.license_plate || c.device_name || `차량 ${c.device_id}`, renter: c.renter_name,
    start: kstDateTime(c.starts_at), end: kstDateTime(c.ends_at), status: statusLabel[rentalStatus(c, now)] || c.status,
    deposit: money(c.deposit_krw), amount: money(c.settled_amount_krw), settled: kstDateTime(c.settled_at),
    base: money(c.base_fee_krw), late: money(c.late_fee_krw), excess: money(c.over_km_fee_krw), extra: money(c.extra_fee_krw),
    refund: money(c.refund_krw ?? (c.settled_amount_krw == null ? null : num(c.deposit_krw) - num(c.settled_amount_krw))), note: c.note || '',
  }));
  const title = settlement ? '렌트카 정산 내역' : '렌트카 계약 목록';
  const common = [column('id','계약 번호'),column('vehicle','차량'),column('renter','임차인')];
  const columns = settlement
    ? [...common,column('settled','정산 일시'),column('base','기본료(원)',true),column('late','지연료(원)',true),column('excess','초과 거리(원)',true),column('extra','기타(원)',true),column('deposit','보증금(원)',true),column('amount','정산액(원)',true),column('refund','환급/추가 청구(원)',true),column('note','메모')]
    : [...common,column('start','대여 시작'),column('end','반납 예정'),column('status','상태'),column('deposit','보증금(원)',true),column('amount','정산액(원)',true),column('note','메모')];
  return { title, filename: `${title.replaceAll(' ','_')}_${businessDate(now)}`, meta: [filterText, '일시: 한국 시간(KST)', ...(settlement ? ['환급은 양수, 추가 청구는 음수입니다.'] : [])].filter(Boolean),
    summary: `${rows.length}건 · ${settlement ? '정산 합계' : '반납 완료 계약 정산 합계'} ${selected.filter(c=>c.status==='returned').reduce((s,c)=>s+num(c.settled_amount_krw),0).toLocaleString('ko-KR')}원`, columns, rows };
}

export function invoiceReport(c) {
  const report = rentalReport([c], { settlement: true });
  return { ...report, title: `렌트카 정산서 #${c.id}`, filename: `렌트카_정산서_${c.id}`,
    meta: [`차량: ${c.license_plate || c.device_name || c.device_id} · 임차인: ${c.renter_name}`, `계약 기간: ${kstDateTime(c.starts_at)} ~ ${kstDateTime(c.ends_at)} (KST)`, ...report.meta],
    columns: [column('item','항목'),column('detail','내역'),column('amount','금액(원)',true)],
    rows: [...(c.settlement_json?.lines || []).map(l => ({ item: ({base:'기본료',late:'지연료',over_km:'초과 거리',extra:'기타'})[l.kind] || l.kind, detail:l.label || '', amount:money(l.amount) })),
      {item:'정산 합계',detail:'',amount:money(c.settled_amount_krw)}, {item:'보증금',detail:'',amount:money(c.deposit_krw)},
      {item:'환급 / 추가 청구',detail:'양수: 환급, 음수: 추가 청구',amount:report.rows[0]?.refund ?? ''}] };
}

export function monthlyReport(rows, { month, estimateFuelCost, estimateDepreciation }) {
  return { title:'법인차 월간 요약',filename:`법인차_월간요약_${month}`,meta:[`대상 월: ${month} (한국 시간)`, '현재 선택한 부서 기준 · 유류비와 감가상각은 추정값입니다.'],summary:`차량 ${rows.length}대 · 총 ${rows.reduce((s,r)=>s+num(r.totalKm),0).toFixed(2)} km`,
    columns:[column('vehicle','차량'),column('department','부서'),column('total','전체(km)',true),column('business','업무(km)',true),column('personal','출퇴근·기타·미지정(km)',true),column('fuel','유류비(원)',true),column('depreciation','감가상각(원)',true)],
    rows:rows.map(r=>({vehicle:r.license_plate || r.label,department:r.department || '부서 없음',total:Number(r.totalKm.toFixed(2)),business:Number(r.businessKm.toFixed(2)),personal:Number(r.personalKm.toFixed(2)),fuel:estimateFuelCost(r),depreciation:estimateDepreciation(r)})) };
}

// RFC 4180 quoting + BOM for Excel. Untrusted text must never become a formula.
export function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function reportCsv(report) {
  return '\uFEFF' + [report.columns.map(c=>csvCell(c.label)).join(','), ...report.rows.map(r=>report.columns.map(c=>csvCell(r[c.key])).join(','))].join('\r\n') + '\r\n';
}
export const safeFilename = name => String(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,140);

export function reportPdfDefinition(report) {
  const columns = report.columns.filter(c=>c.pdf!==false);
  const count = columns.length;
  return {
    pageSize:'A4', pageOrientation: count > 5 ? 'landscape' : 'portrait', pageMargins:[30,36,30,36],
    info:{title:report.title,author:'GPS 차량 운영'}, defaultStyle:{font:'NanumGothic',fontSize:count > 10 ? 8 : 9,color:'#172b46',lineHeight:1.2},
    footer:(page,pages)=>({text:`GPS 차량 운영  |  ${page} / ${pages}`,alignment:'right',fontSize:8,color:'#64748b',margin:[30,12,30,0]}),
    content:[
      {text:report.title,fontSize:21,bold:true,margin:[0,0,0,10]},
      ...report.meta.map(text=>({text,fontSize:9,color:'#53647b',margin:[0,0,0,4]})),
      {text:report.summary,bold:true,fontSize:11,margin:[0,10,0,16]},
      ...(report.rows.length ? [{ table:{headerRows:1,widths:columns.map(()=>'*'),
        body:[columns.map(c=>({text:c.label,bold:true,fillColor:'#eaf0fb',margin:[0,5,0,5]})),
          ...report.rows.map(r=>columns.map(c=>({text:c.numeric && typeof r[c.key]==='number' ? r[c.key].toLocaleString('ko-KR',{maximumFractionDigits:2}) : String(r[c.key] ?? ''),alignment:c.numeric?'right':'left',margin:[0,4,0,4]})))]},
        layout:{hLineWidth:()=>0.5,vLineWidth:()=>0,hLineColor:()=>'#dce3ed',fillColor:i=>i>0&&i%2===0?'#f7f9fc':null,paddingLeft:()=>5,paddingRight:()=>5},
      }] : [{text:'조건에 맞는 내역이 없습니다.',margin:[0,20,0,20]}]),
      {text:'조회 시점의 자료입니다. 진행 중인 운행 및 미정산 계약은 이후 변경될 수 있습니다.',fontSize:8,color:'#64748b',margin:[0,16,0,0]},
    ],
  };
}
