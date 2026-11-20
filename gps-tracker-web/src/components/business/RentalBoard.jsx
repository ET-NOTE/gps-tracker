import { useState } from 'react';
import { useRentalOperations } from './useBusinessData';
import { BusinessButton, BusinessEmpty, BusinessError } from './BusinessWorkspace';
import { businessDate, rentalStatus, vehicleName } from '../../lib/business';
import { addBusinessDays, boardDays, rentalOnDay } from '../../lib/businessWorkspace';
import { kstDateTime } from '../../lib/businessExport';

const labels = { draft: '초안', active: '임대 중', overdue: '반납 지연', returned: '반납 완료' };
export default function RentalBoard({ devices, now, onNew, onEdit }) {
  const today = businessDate(now);
  const [start, setStart] = useState(today), [selectedDay, setSelectedDay] = useState(today), [query, setQuery] = useState('');
  const days = boardDays(start);
  const result = useRentalOperations(now, { from: `${start}T00:00:00+09:00`, to: `${addBusinessDays(start, 7)}T00:00:00+09:00` });
  const rows = devices.filter(d => [vehicleName(d), d.car_model, d.display_name].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  const contracts = result.data || [];
  const changeWeek = next => { setStart(next); setSelectedDay(next); };
  return <div className="business-board">
    <div className="business-filter-bar"><BusinessButton aria-label="이전 7일" onClick={() => changeWeek(addBusinessDays(start, -7))}>←</BusinessButton><label>시작일 <input aria-label="배차표 시작일" type="date" value={start} onChange={e => e.target.value && changeWeek(e.target.value)} /></label><BusinessButton aria-label="다음 7일" onClick={() => changeWeek(addBusinessDays(start, 7))}>→</BusinessButton><BusinessButton onClick={() => changeWeek(today)}>오늘</BusinessButton><input aria-label="배차표 차량 검색" placeholder="차량번호·이름 검색" value={query} onChange={e => setQuery(e.target.value)} /></div>
    <p className="business-note">한국 시간 · 빈 날짜를 누르면 새 계약을 작성합니다. 당일 빈칸도 전후 예약·정비를 확인한 후 배차해 주세요.</p>
    <div className="business-board-legend">{Object.entries(labels).map(([status, label]) => <span key={status} className={`business-schedule-label ${status}`}>{label}</span>)}<span>빗금: 미반납 기간 · 오늘까지 표시</span></div>
    {result.error && <BusinessError onRetry={result.refetch}>배차표를 불러오지 못했습니다. 다시 조회한 뒤 계약을 작성해 주세요.</BusinessError>}
    {result.isLoading ? <p role="status">배차표를 불러오는 중…</p> : !result.error && <>
      <div className="business-board-desktop"><table><caption>{start}부터 7일 차량별 배차표</caption><thead><tr><th>차량</th>{days.map(day => <th key={day} className={day === today ? 'is-today' : ''}>{day.slice(5).replace('-', '/')} <small>{new Date(`${day}T12:00:00+09:00`).toLocaleDateString('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' })}</small>{day === today && <span>오늘</span>}</th>)}</tr></thead><tbody>{rows.map(device => <tr key={device.id}><th>{vehicleName(device)}<small>{device.enabled === false ? '사용 중지' : device.car_model}</small></th>{days.map(day => {
        const items = contracts.filter(c => String(c.device_id) === String(device.id) && rentalOnDay(c, day, now));
        const awaitingReturn = day >= today && contracts.some(c => String(c.device_id) === String(device.id) && rentalStatus(c, now) === 'overdue');
        return <td key={day} className={day === today ? 'is-today' : ''}>{items.length ? items.map(c => <ContractButton key={c.id} contract={c} day={day} now={now} onClick={() => onEdit(c)} />) : <button className="business-board-empty" disabled={device.enabled === false || awaitingReturn} onClick={() => onNew(device.id, day)} aria-label={`${vehicleName(device)} ${day} ${awaitingReturn ? '반납 확인 필요' : '새 계약'}`}>{awaitingReturn ? '반납 확인 필요' : '＋'}</button>}</td>;
      })}</tr>)}</tbody></table></div>
      <div className="business-board-mobile"><div className="business-day-strip" aria-label="배차표 날짜">{days.map(day => <button className="business-day-button" key={day} aria-pressed={day === selectedDay} onClick={() => setSelectedDay(day)}>{day.slice(8)}<small>{day === today ? '오늘' : new Date(`${day}T12:00:00+09:00`).toLocaleDateString('ko-KR', { weekday: 'short', timeZone: 'Asia/Seoul' })}</small></button>)}</div>{rows.map(device => {
        const items = contracts.filter(c => String(c.device_id) === String(device.id) && rentalOnDay(c, selectedDay, now));
        const awaitingReturn = selectedDay >= today && contracts.some(c => String(c.device_id) === String(device.id) && rentalStatus(c, now) === 'overdue');
        return <section key={device.id} className="business-agenda-vehicle"><h3>{vehicleName(device)}</h3>{items.length ? items.map(c => <ContractButton key={c.id} contract={c} day={selectedDay} now={now} onClick={() => onEdit(c)} />) : <BusinessButton disabled={device.enabled === false || awaitingReturn} onClick={() => onNew(device.id, selectedDay)}>{device.enabled === false ? '사용 중지 차량' : awaitingReturn ? '반납 확인 후 배차 가능' : '이 날짜에 새 계약'}</BusinessButton>}</section>;
      })}</div>
      {!rows.length && <BusinessEmpty title={devices.length ? '검색 결과가 없습니다.' : '등록된 차량이 없습니다.'} />}
    </>}
  </div>;
}
function ContractButton({ contract, day, now, onClick }) {
  const status = rentalStatus(contract, now), late = status === 'overdue' && day >= businessDate(contract.ends_at);
  return <button className={`business-schedule-contract ${status}${late ? ' late' : ''}`} onClick={onClick} title={`${contract.renter_name} · ${kstDateTime(contract.starts_at)} ~ ${kstDateTime(contract.ends_at)}`}><strong>{contract.renter_name || '임차인 미등록'}</strong><span>{labels[status] || status}</span><small>{businessDate(contract.starts_at).slice(5)} → {businessDate(contract.ends_at).slice(5)}</small></button>;
}
