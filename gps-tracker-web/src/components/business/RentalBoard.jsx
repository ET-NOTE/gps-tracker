import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { isAssigned, matchesVehicle } from '../../lib/rentalInventory';
import { fleetWorkKey } from './RentalFleetWork';
import { repairNames, workState } from '../../lib/rentalFleet';
import { useRentalOperations } from './useBusinessData';
import { BusinessButton, BusinessEmpty, BusinessError } from './BusinessWorkspace';
import { businessDate, rentalStatus, vehicleName } from '../../lib/business';
import { addBusinessDays, boardDays, rentalOnDay } from '../../lib/businessWorkspace';
import { kstDateTime } from '../../lib/businessExport';

const labels = { draft: '예약', active: '대여 중', overdue: '반납 지연', returned: '반납 완료' };
export default function RentalBoard({ devices, now, onNew, onEdit }) {
  const today = businessDate(now);
  const [start, setStart] = useState(today), [selectedDay, setSelectedDay] = useState(today), [query, setQuery] = useState('');
  const [branch,setBranch]=useState(''),[model,setModel]=useState('');
  const work=useQuery({queryKey:fleetWorkKey(),queryFn:api.rentalFleetWork,staleTime:15000});
  const info=new Map(devices.map(v=>[v.id,v]));
  const classOf=d=>info.get(d.id)?.class_name || d.car_model || '';
  const days = boardDays(start);
  const result = useRentalOperations(now, { from: `${start}T00:00:00+09:00`, to: `${addBusinessDays(start, 7)}T00:00:00+09:00` });
  const needle=query.trim().toLowerCase();
  const rows = devices.filter(d => (!branch || info.get(d.id)?.branch===branch) && (!model || classOf(d)===model) &&
    [vehicleName(d), d.car_model, d.display_name].some(v => String(v || '').toLowerCase().includes(needle)));
  const contracts = result.data || [];
  const waiting=contracts.filter(c=>c.status==='draft' && !isAssigned(c) && days.some(day=>rentalOnDay(c,day,now))
    && (!branch || c.pickup_location===branch) && (!model || c.rental_terms?.requested_model===model)
    && (!needle || [c.renter_name,c.rental_terms?.requested_model,'R-'+c.id].some(value=>String(value||'').toLowerCase().includes(needle))));
  const branches=[...new Set([...devices.map(p=>p.branch),...contracts.map(c=>c.pickup_location)].filter(Boolean))].sort();
  const models=[...new Set([...devices.map(classOf),...contracts.map(c=>c.rental_terms?.requested_model)].filter(Boolean))].sort();
  function preparation(device,day) {
    const from=Date.parse(day+'T00:00:00+09:00'),to=from+86400000;
    const tasks=(work.data||[]).filter(w=>matchesVehicle(w,device) && Date.parse(w.starts_at)<to && workState(w)!=='done' &&
      (workState(w)==='review' || w.return_inspection || !w.ends_at || Date.parse(w.ends_at)>from));
    return tasks.map(w=><span className="rental-board-work" key={w.id}>{repairNames[w.kind] || '점검'}{workState(w)==='review'?' · 조치 후 점검':''}</span>);
  }
  const changeWeek = next => { setStart(next); setSelectedDay(next); };
  return <div className="business-board">
    <div className="rental-board-scope"><label>인수 지점<select value={branch} onChange={e=>setBranch(e.target.value)}><option value="">전체 지점</option>{branches.map(s=><option key={s}>{s}</option>)}</select></label>
      <label>차종<select value={model} onChange={e=>setModel(e.target.value)}><option value="">전체 차종</option>{models.map(s=><option key={s}>{s}</option>)}</select></label></div>
    <div className="business-filter-bar"><BusinessButton aria-label="이전 7일" onClick={() => changeWeek(addBusinessDays(start, -7))}>←</BusinessButton><label>시작일 <input aria-label="배차표 시작일" type="date" value={start} onChange={e => e.target.value && changeWeek(e.target.value)} /></label><BusinessButton aria-label="다음 7일" onClick={() => changeWeek(addBusinessDays(start, 7))}>→</BusinessButton><BusinessButton onClick={() => changeWeek(today)}>오늘</BusinessButton><input aria-label="배차표 차량 검색" placeholder="차량번호·이름 검색" value={query} onChange={e => setQuery(e.target.value)} /></div>
    {waiting.length>0 && <section className="rental-board-unassigned"><h2>미배정 예약 <small>{waiting.length}건</small></h2>{waiting.map(c=><BusinessButton key={c.id} onClick={()=>onEdit(c)}>{c.renter_name} · R-{c.id} · {c.rental_terms?.requested_model || '차종 미지정'}</BusinessButton>)}</section>}
    {work.isError && <BusinessError onRetry={work.refetch}>차량 준비 일정이나 소속 지점을 불러오지 못했습니다.</BusinessError>}
    <div className="business-board-legend">{Object.entries(labels).map(([status, label]) => <span key={status} className={`business-schedule-label ${status}`}>{label}</span>)}<span>빗금: 미반납 기간 · 오늘까지 표시</span></div>
    {result.error && <BusinessError onRetry={result.refetch}>배차표를 불러오지 못했습니다. 다시 조회한 뒤 계약을 작성해 주세요.</BusinessError>}
    {result.isLoading ? <p role="status">배차표를 불러오는 중…</p> : !result.error && <>
      <div className="business-board-desktop"><table><caption>{start}부터 7일 차량별 배차표</caption><thead><tr><th>차량</th>{days.map(day => <th key={day} className={day === today ? 'is-today' : ''}>{day.slice(5).replace('-', '/')} <small>{new Date(`${day}T12:00:00+09:00`).toLocaleDateString('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' })}</small>{day === today && <span>오늘</span>}</th>)}</tr></thead><tbody>{rows.map(device => <tr key={device.id}><th>{vehicleName(device)}<small>{device.enabled === false ? '사용 중지' : device.car_model}</small></th>{days.map(day => {
        const items = contracts.filter(c => matchesVehicle(c,device) && rentalOnDay(c, day, now));
        const awaitingReturn = day >= today && contracts.some(c => matchesVehicle(c,device) && rentalStatus(c, now) === 'overdue');
        return <td key={day} className={day === today ? 'is-today' : ''}>{preparation(device,day)}{items.length ? items.map(c => <ContractButton key={c.id} contract={c} day={day} now={now} onClick={() => onEdit(c)} />) : <button className="business-board-empty" disabled={device.enabled === false || awaitingReturn} onClick={() => onNew(device.id, day)} aria-label={`${vehicleName(device)} ${day} ${awaitingReturn ? '반납 확인 필요' : '새 계약'}`}>{awaitingReturn ? '반납 확인 필요' : '＋'}</button>}</td>;
      })}</tr>)}</tbody></table></div>
      <div className="business-board-mobile"><div className="business-day-strip" aria-label="배차표 날짜">{days.map(day => <button className="business-day-button" key={day} aria-pressed={day === selectedDay} onClick={() => setSelectedDay(day)}>{day.slice(8)}<small>{day === today ? '오늘' : new Date(`${day}T12:00:00+09:00`).toLocaleDateString('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' })}</small></button>)}</div>{rows.map(device => {
        const items = contracts.filter(c => matchesVehicle(c,device) && rentalOnDay(c, selectedDay, now));
        const awaitingReturn = selectedDay >= today && contracts.some(c => matchesVehicle(c,device) && rentalStatus(c, now) === 'overdue');
        return <section key={device.id} className="business-agenda-vehicle"><h3>{vehicleName(device)}</h3>{preparation(device,selectedDay)}{items.length ? items.map(c => <ContractButton key={c.id} contract={c} day={selectedDay} now={now} onClick={() => onEdit(c)} />) : <BusinessButton disabled={device.enabled === false || awaitingReturn} onClick={() => onNew(device.id, selectedDay)}>{device.enabled === false ? '사용 중지 차량' : awaitingReturn ? '반납 확인 후 배차 가능' : '이 날짜에 새 계약'}</BusinessButton>}</section>;
      })}</div>
      {!rows.length && <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'} />}
    </>}
  </div>;
}
function ContractButton({ contract, day, now, onClick }) {
  const status = rentalStatus(contract, now), late = status === 'overdue' && day >= businessDate(contract.ends_at);
  return <button className={`business-schedule-contract ${status}${late ? ' late' : ''}`} onClick={onClick} title={`${contract.renter_name} · ${kstDateTime(contract.starts_at)} ~ ${kstDateTime(contract.ends_at)}`}><strong>{contract.renter_name || '임차인 미등록'}</strong><span>{labels[status] || status}</span><small>{businessDate(contract.starts_at).slice(5)} → {businessDate(contract.ends_at).slice(5)}</small></button>;
}
