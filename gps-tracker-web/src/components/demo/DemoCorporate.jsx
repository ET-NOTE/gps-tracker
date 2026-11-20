import { useState } from 'react';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import Pill from '../ui/Pill';
import { expenseMoney, expenseStatus, paymentMethods } from '../../lib/fleetExpenses';
import { demoVehicles } from './demoVehicles';
import './DemoCorporate.css';

const pages = { vehicles: '차량 목록', trips: '운행기록부', expenses: '지출 내역' };
const fleetAssignments = {
  'seoul-01': { department: '영업팀', driver: '김하늘', odo: 24820, latestTripId: 's2', note: '거래처 방문' },
  'incheon-02': { department: '현장지원팀', driver: '이도윤', odo: 18346, latestTripId: 'i2', note: '현장 장비 점검' },
};
const vehicles = demoVehicles.filter(vehicle => vehicle.service === 'corporate')
  .map(vehicle => ({...vehicle, ...fleetAssignments[vehicle.id]}));
const byVehicle = Object.fromEntries(vehicles.map(v => [v.id, v]));
const trips = [
  ...vehicles.map(v => ({
    id: v.latestTripId, vehicle: v.id, day:'2026-11-20', start:v.start, end:v.end, from:v.from, to:v.to, purpose:'업무', note:v.note, km:v.km,
  })).sort((a,b) => b.start.localeCompare(a.start)),
  { id: 'i1', vehicle: 'incheon-02', day: '2026-11-19', start: '18:08', end: '18:24', from: '인천대입구역', to: '송도 센트럴파크역', purpose: '출퇴근', note: '퇴근', km: 4.3 },
  { id: 's1', vehicle: 'seoul-01', day: '2026-11-19', start: '15:20', end: '15:37', from: '서울숲', to: '성수역', purpose: '업무', note: '거래처 방문 후 복귀', km: 3.6 },
];
const expenses = [
  { id: 'e3', trip: 's2', item: '주차비', merchant: '서울숲 방문 주차장', amount: 6000, status: 'approved', payment: 'company_card' },
  { id: 'e2', trip: 'i2', item: '유류비', merchant: '송도 주유소', amount: 52000, status: 'pending', payment: 'personal_card' },
  { id: 'e1', trip: 's1', item: '유류비', merchant: '성수 주유소', amount: 48000, status: 'approved', payment: 'company_card' },
];
const byTrip = Object.fromEntries(trips.map(t => [t.id, t]));
const money = n => expenseMoney(n) + '원';
const distance = km => km.toLocaleString('ko-KR', { maximumFractionDigits: 1 }) + ' km';
const interval = t => t.start + ' – ' + t.end;
const journey = t => t.from + ' → ' + t.to;
const expenseBadge = e => <Pill tone={e.status === 'approved' ? 'success' : 'primary'} size="md">{expenseStatus[e.status]}</Pill>;
const matches = (query, ...parts) => query.trim().toLowerCase().split(/\s+/).every(term => parts.join(' ').toLowerCase().includes(term));

function TwoLines({ title, sub }) {
  return <span className="demo-corp-value"><strong>{title}</strong><small>{sub}</small></span>;
}

function Filter({ label, value, onChange, options }) {
  return <label className="demo-corp-filter"><span>{label}</span>
    <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}>
      {options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
    </select>
  </label>;
}

function Ledger({ label, columns, rows, onOpen, onClear }) {
  return <div className="demo-corp-results">
    <div className="demo-corp-result-count" role="status">{label} <b>{rows.length}건</b></div>
    {rows.length === 0 ? <div className="demo-corp-empty">
      <p>조회 조건에 맞는 항목이 없습니다.</p><button type="button" onClick={onClear}>조회 조건 초기화</button>
    </div> : <table className="demo-corp-table" aria-label={label}>
      <thead><tr>{columns.map(name => <th key={name} scope="col">{name}</th>)}<th scope="col">상세</th></tr></thead>
      <tbody>{rows.map(({ id, cells, description }) => <tr key={id}>
        {cells.map((cell, index) => <td key={columns[index]} data-label={columns[index]}>{cell}</td>)}
        <td className="demo-corp-row-action"><button type="button" onClick={() => onOpen(id)} aria-label={description + ' 상세 보기'}>상세 보기<Icon name="chevron-right" size={14}/></button></td>
      </tr>)}</tbody>
    </table>}
  </div>;
}

function CorporateList({ page, onMap }) {
  const [query, setQuery] = useState('');
  const [vehicleId, setVehicleId] = useState('');
  const [status, setStatus] = useState('');
  const [detailId, setDetailId] = useState(null);
  function clear() { setQuery(''); setVehicleId(''); setStatus(''); }
  let columns, rows, summary, detail;
  const vehicleMatches = (v, ...extra) => (!vehicleId || v.id === vehicleId) && matches(query, v.name, v.plate, v.department, v.driver, v.model, ...extra);

  if (page === 'vehicles') {
    columns = ['차량', '부서', '담당자', '누적거리'];
    rows = vehicles.filter(v => vehicleMatches(v)).map(v => ({ id: v.id, description: v.name,
      cells: [<TwoLines title={v.name} sub={v.plate + ' · ' + v.model}/>, v.department, v.driver, distance(v.odo)] }));
    const v = byVehicle[detailId];
    if (v) detail = { title: v.name, subtitle: v.plate, vehicle: v, fields: [
      ['차종',v.model], ['부서',v.department], ['담당자',v.driver], ['누적거리',distance(v.odo)],
      ['최근 운행',journey(trips.find(t => t.vehicle === v.id))],
    ] };
  } else if (page === 'trips') {
    columns = ['운행 일시', '차량 · 운전자', '출발지 → 도착지', '운행 목적', '주행거리'];
    const filtered = trips.filter(t => (!status || t.purpose === status) && vehicleMatches(byVehicle[t.vehicle], t.from, t.to, t.note));
    rows = filtered.map(t => ({ id: t.id, description: t.day + ' ' + t.start + ' 운행', cells: [
      <TwoLines title={t.day} sub={interval(t)}/>, <TwoLines title={byVehicle[t.vehicle].name} sub={byVehicle[t.vehicle].driver}/>,
      journey(t), t.purpose, distance(t.km),
    ] }));
    summary = '총 주행거리 ' + distance(filtered.reduce((sum,t) => sum + t.km,0));
    const t = byTrip[detailId];
    if (t) detail = { title: '운행 상세', subtitle: t.day + ' · ' + interval(t), vehicle: byVehicle[t.vehicle], fields: [
      ['차량',byVehicle[t.vehicle].name], ['운전자',byVehicle[t.vehicle].driver], ['출발지',t.from], ['도착지',t.to],
      ['주행거리',distance(t.km)], ['운행 목적',t.purpose], ['비고',t.note],
    ] };
  } else {
    columns = ['지출일', '승인 상태', '차량 · 사용자', '지출 항목', '결제수단', '금액'];
    const filtered = expenses.filter(e => (!status || e.status === status) && vehicleMatches(byVehicle[byTrip[e.trip].vehicle], e.item, e.merchant));
    rows = filtered.map(e => {
      const t = byTrip[e.trip], v = byVehicle[t.vehicle];
      return { id: e.id, description: e.merchant + ' ' + e.item, cells: [
        t.day, expenseBadge(e), <TwoLines title={v.name} sub={v.driver}/>, e.item, paymentMethods[e.payment], money(e.amount),
      ] };
    });
    const approved = filtered.filter(e => e.status === 'approved');
    summary = '승인 금액 ' + money(approved.reduce((sum,e) => sum + e.amount,0));
    const e = expenses.find(row => row.id === detailId);
    if (e) {
      const t = byTrip[e.trip], v = byVehicle[t.vehicle];
      detail = { title: '지출 상세', subtitle: e.item + ' · ' + money(e.amount), vehicle: v, fields: [
        ['승인 상태',expenseBadge(e)], ['지출일',t.day], ['사용처',e.merchant], ['차량',v.name],
        ['사용자',v.driver + ' · ' + v.department], ['결제수단',paymentMethods[e.payment]], ['연결 운행',journey(t)],
      ] };
    }
  }
  const searchHint = page === 'vehicles' ? '차량·부서·담당자 검색' : page === 'trips' ? '차량·운전자·경로 검색' : '차량·사용자·사용처 검색';
  return <>
    <div className="demo-corp-toolbar">
      <label className="demo-corp-search"><Icon name="search" size={17}/><input type="search" aria-label={searchHint} placeholder={searchHint} value={query} onChange={e=>setQuery(e.target.value)}/></label>
      {page !== 'vehicles' && <Filter label="차량" value={vehicleId} onChange={setVehicleId} options={[['','전체 차량'],...vehicles.map(v=>[v.id,v.name])]}/>}
      {page === 'trips' && <Filter label="운행 목적" value={status} onChange={setStatus} options={[['','전체 목적'],['업무','업무'],['출퇴근','출퇴근']]}/>}
      {page === 'expenses' && <Filter label="승인 상태" value={status} onChange={setStatus} options={[['','전체 상태'],['approved',expenseStatus.approved],['pending',expenseStatus.pending]]}/>}
      {summary && <span className="demo-corp-summary" aria-live="polite">{summary}</span>}
    </div>
    <Ledger label={pages[page]} columns={columns} rows={rows} onOpen={setDetailId} onClear={clear}/>
    <Modal open={!!detail} title={detail?.title} subtitle={detail?.subtitle} onClose={() => setDetailId(null)} footer={detail && onMap &&
      <button className="demo-corp-map-button" type="button" onClick={() => {setDetailId(null); onMap(detail.vehicle.id);}}>
        <Icon name="mapPin" size={16}/>차량 위치 보기
      </button>}>
      {detail && <dl className="demo-corp-fields">{detail.fields.map(([name,value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>}
    </Modal>
  </>;
}

export default function DemoCorporate({ page = 'vehicles', onPage, onMap }) {
  const current = Object.hasOwn(pages,page) ? page : 'vehicles';
  return <section className="demo-corp" aria-label="법인운행">
    <nav className="demo-corp-nav" aria-label="법인운행 메뉴">
      {Object.entries(pages).map(([key,label]) => <button type="button" key={key} aria-current={key === current ? 'page' : undefined} onClick={() => onPage(key)}>{label}</button>)}
    </nav>
    <div className="demo-corp-body"><CorporateList key={current} page={current} onMap={onMap}/></div>
  </section>;
}
