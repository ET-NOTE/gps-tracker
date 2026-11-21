import { useState } from 'react';
import { isAssigned, matchesVehicle } from '../../lib/rentalInventory';
import Icon from '../Icon';
import { businessDate } from '../../lib/business';
import { kstDateTime } from '../../lib/businessExport';
import { contractStage, fleetDashboard, rentalFleetLabel, repairNames, isIncident } from '../../lib/rentalFleet';
import { BusinessButton, BusinessEmpty, useBusinessVehicle } from './BusinessWorkspace';
import BusinessDrawer from './BusinessDrawer';

function ActionLink({ children, onClick }) {
  return <button className="rfl-more" type="button" onClick={onClick}>{children}<Icon name="chevron-right" size={14} /></button>;
}

export default function RentalDashboard({ devices, contracts, work, now, onTab, onContracts, onNew, onWork, branches: configuredBranches = [] }) {
  const [branch, setBranch] = useState(''), [detail, setDetail] = useState('');
  const openVehicle = useBusinessVehicle(), filteredDevices = devices.filter(d => !branch || d.rental_profile?.branch === branch);
  const branches = [...new Set([...configuredBranches.map(b=>typeof b==='string'?b:b.name),
    ...devices.map(d=>d.rental_profile?.branch), ...contracts.map(c=>c.pickup_location)].filter(Boolean))].sort();
  const filteredContracts = contracts.filter(c => !branch || filteredDevices.some(d => matchesVehicle(c,d))
    || (!isAssigned(c) && c.pickup_location === branch));
  const filteredWork = work.filter(row => !branch || filteredDevices.some(d => matchesVehicle(row,d)));
  const data = fleetDashboard(filteredContracts, filteredDevices, filteredWork, now);
  const metrics = [
    ['active', '대여 중', data.summary.occupied.size, '대', 'car', '현재 대여 차량'], ['pickup', '오늘 출고', data.pickups.length, '건', 'route', '오늘 인도·출고 예정'],
    ['return', '오늘 반납', data.returns.length, '건', 'clock', '반납 완료·예정 포함'], ['tasks', '확인할 일', data.taskCount, '건', 'warn', '배차·반납·차량 준비'],
  ];
  const groups = detail === 'tasks' ? data.actions : data.actions.filter(task => detail === 'task-' + task.key);
  const groupRows = groups.flatMap(group => group.rows.map(item => ({ ...item, label: group.label, key: group.key })));
  const contractsToOpen = detail === 'active' ? data.summary.open.filter(c => filteredDevices.some(v=>matchesVehicle(c,v) && data.summary.occupied.has(String(v.id)))) :
    detail === 'pickup' ? data.pickups.map(e => e.row) : detail === 'return' ? data.returns.map(e => e.row) : [];
  const drawerTitle = (metrics.find(([key]) => key === detail) || [])[1] || groups[0]?.label;
  const trendMax = Math.max(1, ...data.trend.map(x => x.count)), countMax = Math.max(1, ...Object.values(data.counts));
  function action(item) {
    setDetail('');
    if (item.contract) onContracts(item.key === 'return' && ['active', 'overdue'].includes(item.contract.status) ? { returning: item.contract } : { contract: item.contract });
    else if (item.item) onWork(isIncident(item.item.kind) ? 'incidents' : 'service', item.item.id);
    else if (item.device) item.device.terminal ? openVehicle?.(item.device.terminal) : onTab('vehicles');
  }
  return <div className="rfl-page rfl-dashboard">
    <div className="rfl-toolbar"><div className="rfl-inline"><span className="rfl-date">{businessDate(now).replaceAll('-', '.')} · 오늘</span>
      <label className="rfl-branch">운영 지점<select value={branch} onChange={e => setBranch(e.target.value)}><option value="">전체 지점</option>{branches.map(b => <option key={b}>{b}</option>)}</select></label>
    </div><div className="rfl-buttons"><BusinessButton onClick={() => onTab('schedule')}>배차 현황</BusinessButton><BusinessButton primary icon="plus" onClick={onNew}>예약 등록</BusinessButton></div></div>
    <section className="rfl-summary" aria-label="렌트카 운영 지표">{metrics.map(([key, label, value, unit, icon, hint]) => <button type="button" className="rfl-metric" key={key} onClick={() => setDetail(key)} aria-label={label + ' ' + value + unit + ' 상세'}>
      <span><Icon name={icon} size={15}/><span>{label}</span><small className="rfl-metric-link">더보기 <Icon name="chevron-right" size={12}/></small></span><strong>{value.toLocaleString()}<small>{unit}</small></strong><span className="rfl-metric-note">{hint}</span>
    </button>)}</section>
    <div className="rfl-dashboard-grid"><section className="rfl-card"><header><div><h2>오늘 인도·반납</h2><p className="rnt-section-caption">시간순 · {data.timeline.length}건</p></div><ActionLink onClick={() => onTab('schedule')}>전체 일정</ActionLink></header>
      <div className="rfl-table-scroll" role="region" aria-label="오늘 인도·반납 일정" tabIndex={0}><table className="rfl-table rfl-timeline"><thead><tr><th>시간</th><th>구분</th><th>고객</th><th>차량</th><th>상태</th></tr></thead><tbody>
        {data.timeline.slice(0, 7).map(({ at, type, row }) => <tr key={type + row.id}><td data-label="시간">{kstDateTime(at).slice(-5)}</td>
          <td data-label="구분"><span className="rfl-badge" data-tone={type === '출고' ? 'active' : 'ready'}>{type}</span></td>
          <td data-label="고객"><button className="rfl-link" onClick={() => onContracts({ contract: row })}>{row.renter_name}</button></td>
          <td data-label="차량">{row.license_plate || row.device_name || '배차 대기'}</td><td data-label="상태">{contractStage(row, now)}</td></tr>)}
        {!data.timeline.length && <tr><td className="rental-list-empty" colSpan={5}>오늘 인도·반납 내역이 없습니다.</td></tr>}
      </tbody></table></div></section>
    <section className="rfl-card"><header><h2>확인할 일</h2><ActionLink onClick={() => setDetail('tasks')}>전체 보기</ActionLink></header>
      <div className="rfl-tasks">{data.actions.map(task => <button type="button" className="rfl-task" key={task.key} onClick={() => setDetail('task-' + task.key)}><i><Icon name={task.icon} size={17}/></i><span>{task.label}</span><b data-active={task.rows.length > 0}>{task.rows.length}건</b><Icon name="chevron-right" size={15}/></button>)}</div></section>
    </div><div className="rfl-dashboard-grid rfl-dashboard-bottom"><section className="rfl-card"><header><div><h2>차량 준비 현황</h2><p className="rnt-section-caption">선택한 지점의 차량 {filteredDevices.length}대</p></div><ActionLink onClick={() => onTab('vehicles')}>차량 목록</ActionLink></header>
      <ul className="rfl-capacity">{[['ready','대여 가능'],['active','대여 중'],['service','세차·점검'],['hold','배차 보류']].map(([k,v]) => <li key={k}><span>{v}</span><span className="rfl-meter"><i data-tone={k} style={{width:(data.counts[k] / countMax * 100) + '%'}} /></span><b>{data.counts[k]}대</b></li>)}</ul></section>
    <section className="rfl-card"><header><h2>최근 7일 출고</h2><span className="rfl-date">시작일 기준</span></header>
      <figure className="rental-line-chart" aria-label="날짜별 출고 건수"><svg viewBox="0 0 300 84" preserveAspectRatio="none" aria-hidden="true">
        {[12,32,52,72].map(y=><line key={y} x1="7" x2="293" y1={y} y2={y}/>)}
        <polyline points={data.trend.map(({count},i)=>(7+i*286/6)+','+(72-count/trendMax*60)).join(' ')}/>
        {data.trend.map(({day,count},i)=><circle key={day} cx={7+i*286/6} cy={72-count/trendMax*60} r="2.5"/>)}
      </svg><ol>{data.trend.map(({day,count})=><li key={day}><small>{day.slice(5).replace('-','.')}</small><span>{count}건</span></li>)}</ol></figure></section></div>
    {detail && <BusinessDrawer title={drawerTitle} onClose={() => setDetail('')}>
      <div className="rfl-drawer-list">
        {contractsToOpen.map(c => <button type="button" className="rfl-record" key={c.id} onClick={() => { setDetail(''); onContracts({contract:c}); }}><strong>{c.renter_name} · {c.license_plate || c.device_name || '배차 대기'}</strong><small>{kstDateTime(c.starts_at)} ~ {kstDateTime(c.ends_at)} · {contractStage(c, now)}</small></button>)}
        {groupRows.map((row, i) => <button type="button" className="rfl-record" key={row.key + (row.contract?.id || row.item?.id || i)} onClick={() => action(row)}><strong>{row.contract?.renter_name || (row.device && rentalFleetLabel(row.device)) || repairNames[row.item?.kind]} · {row.label}</strong>
          <small>{row.item ? [filteredDevices.find(d => matchesVehicle(row.item,d))?.car_plate, kstDateTime(row.item.starts_at), row.item.note].filter(Boolean).join(' · ') : row.description || kstDateTime(row.contract?.starts_at)}</small></button>)}
        {!contractsToOpen.length && !groupRows.length && <BusinessEmpty compact title="해당 내역이 없습니다." />}
      </div>
    </BusinessDrawer>}
  </div>;
}
