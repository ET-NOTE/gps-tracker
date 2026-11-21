import { useState } from 'react';
import Icon from '../Icon';
import BusinessDrawer from './BusinessDrawer';
import { FreightRecordActions } from './FreightWorkflow';
import { Status } from './FreightDetail';
import { FreightBadge, FreightButton, FreightField, FreightOptions, FreightStageChart, FreightTable } from './FreightKit';
import { epoch, firstOrder, inputTime, nameOf, orderStates, routeName, shipStates, stamp, timeLabel, vehicleName } from '../../lib/freightWorkflow';

function OverviewTable({kind, rows, data, open}) {
  const orders = kind === 'orders';
  const columns = orders ? ['주문 / 화주','경로 / 일정','화물 조건','상태'] : ['운송 / 화주','차량 / 기사','경로 / 일정','상태'];
  return <FreightTable columns={columns} empty={orders ? '배차 대기 주문이 없습니다.' : '해당 운송 일정이 없습니다.'} rows={rows.map(row => {
    const order = orders ? row : firstOrder(data,row);
    const route = <>{routeName(data,order)}<small>{timeLabel(row.start)}</small></>;
    return {id:row.id, onOpen:()=>open(kind,row.id), cells:[
      <><button type="button" className="fr-link" onClick={()=>open(kind,row.id)}>{row.number}</button><small>{nameOf(data,'shippers',order?.shipperId)}</small></>,
      orders ? route : <>{vehicleName(data,row.vehicleId)}<small>{nameOf(data,'drivers',row.driverId)}</small></>,
      orders ? <>{row.vehicleType}<small>{row.weightKg.toLocaleString('ko-KR')} kg</small></> : route,
      <Status value={row.status} labels={orders ? orderStates : shipStates}/>
    ]};
  })}/>;
}

function ActivityList({items}) {
  return items.length ? <ul className="fr-activity">{items.map((item,index)=><li key={index}><span>{item.text}</span><time>{timeLabel(item.at)}</time></li>)}</ul>
    : <p className="fr-empty">처리 이력이 없습니다.</p>;
}

function DashboardCard({title,onMore,children}) {
  return <section className="fr-dashboard-card"><header><h2>{title}</h2><button type="button" className="fr-more" aria-label={title+' 더보기'} onClick={onMore}>더보기 <span aria-hidden="true">›</span></button></header>{children}</section>;
}

function DashboardView({data,devices,onPage,actions}) {
  const [branch,setBranch] = useState(''), [view,setView] = useState('');
  const now=Date.now(), today=stamp(now).slice(0,10);
  const inBranch = record => !branch || record.branchId===branch;
  const orders=data.orders.filter(inBranch).filter(o=>o.status!=='cancelled');
  const ships=data.shipments.filter(inBranch).filter(s=>s.status!=='cancelled');
  const fleet=data.vehicles.filter(inBranch), vehicles=new Set(fleet.map(v=>v.id));
  const todayOrders=orders.filter(o=>inputTime(o.start).slice(0,10)===today);
  const unassigned=orders.filter(o=>o.status==='open');
  const moving=ships.filter(s=>['loading','in_transit'].includes(s.status));
  const schedule=ships.filter(s=>[s.start,s.end].some(at=>inputTime(at).slice(0,10)===today)).sort((a,b)=>epoch(a.start)-epoch(b.start));
  const pending=ships.filter(s=>s.status==='requested');
  const late=ships.filter(s=>s.status!=='delivered' && epoch(s.end)<now);
  const proofs=ships.filter(s=>s.status==='delivered' && s.proof?.status!=='approved');
  const incidents=data.incidents.filter(i=>i.status==='open' && vehicles.has(i.vehicleId));
  const deviceById = new Map(devices.map(d=>[String(d.id),d]));
  const delayed=fleet.filter(v=>{
    if(!v.deviceId)return false;
    const seen=Date.parse(deviceById.get(String(v.deviceId))?.last_seen_at);
    return !Number.isFinite(seen)|| now-seen>data.policies.offlineMinutes*60000;
  });
  const tasks=[
    ['pending','협력사·기사 수락 대기',pending,'cargo-dispatch','clock'],
    ['late','예정 시간이 지난 운송',late,'cargo-shipments','route'],
    ['proofs','인수증 확인 필요',proofs,'cargo-proofs','file'],
    ['incidents','처리 중인 지연·사고',incidents,'cargo-incidents','warn'],
    ['devices','단말 수신 확인',delayed,'cargo-devices','antenna'],
  ];
  const count=tasks.reduce((sum,[,,items])=>sum+items.length,0);
  const metrics=[['today','오늘 주문',todayOrders.length],['unassigned','미배차',unassigned.length],['moving','상차·운송 중',moving.length],['attention','확인할 업무',count]];
  const taskButtons=<div className="fr-dashboard-tasks">{tasks.map(([id,label,items,,icon])=><button type="button" className="fr-task" key={id} onClick={()=>setView(id)}>
    <i><Icon name={icon} size={16}/></i><span>{label}</span><FreightBadge tone={items.length?'amber':'neutral'}>{items.length}건</FreightBadge>
  </button>)}</div>;
  const selectedTask=tasks.find(([id])=>id===view);
  const title=selectedTask?.[1]||{today:'오늘 상차 예정 주문',unassigned:'미배차 주문',moving:'상차·운송 중',schedule:'오늘 운송 일정',attention:'확인할 업무',activity:'최근 처리 이력'}[view];
  const rows=selectedTask?.[2]||({today:todayOrders,unassigned,moving,schedule}[view]);
  const open=(kind,id)=>{setView('');actions.open(kind,id);};
  return <div className="fr-page fr-dashboard">
    <div className="fr-stats fr-summary" aria-label="화물배차 요약">{metrics.map(([key,label,value])=><button type="button" className="fr-metric" key={key} aria-label={label+' '+value+'건 더보기'} onClick={()=>setView(key)}>
      <span>{label}<small>더보기 ›</small></span><strong>{value}<em>건</em></strong>
    </button>)}</div>
    <div className="fr-toolbar fr-dashboard-tools"><FreightField label="운영 지점"><select value={branch} onChange={e=>setBranch(e.target.value)}><FreightOptions rows={data.branches} blank="전체 지점"/></select></FreightField>
      <div className="fr-actions"><FreightButton onClick={()=>onPage('cargo-live')} icon="map">실시간 관제</FreightButton><FreightButton primary icon="plus" onClick={()=>actions.form('new','orders')}>주문 등록</FreightButton></div>
    </div>
    {actions.feedback&&<p role="status" className="fr-note">{actions.feedback}</p>}
    <div className="fr-overview-grid">
      <DashboardCard title="오늘 운송 일정" onMore={()=>setView('schedule')}><OverviewTable kind="shipments" data={data} rows={schedule.slice(0,5)} open={open}/></DashboardCard>
      <DashboardCard title="확인할 업무" onMore={()=>setView('attention')}>{taskButtons}</DashboardCard>
    </div>
    <div className="fr-overview-grid secondary">
      <DashboardCard title="미배차 주문" onMore={()=>setView('unassigned')}><OverviewTable kind="orders" data={data} rows={unassigned.slice(0,3)} open={open}/></DashboardCard>
      <DashboardCard title="운송 진행 분포" onMore={()=>onPage('cargo-reports')}><FreightStageChart ships={ships}/></DashboardCard>
    </div>
    <DashboardCard title="최근 처리 이력" onMore={()=>setView('activity')}><ActivityList items={data.activity.slice(0,4)}/></DashboardCard>
    {title&&<BusinessDrawer title={title} onClose={()=>setView('')}><div className="fr-section">
      {view==='attention' ? taskButtons : view==='activity' ? <ActivityList items={data.activity}/> :
        view==='incidents' ? <FreightTable columns={['차량','구분','발생 일시','내용']} rows={incidents.map(i=>({id:i.id,cells:[vehicleName(data,i.vehicleId),i.type,timeLabel(i.at),i.note]}))}/> :
        view==='devices' ? <FreightTable columns={['차량','단말기','마지막 수신']} rows={delayed.map(v=>{
          const d=deviceById.get(String(v.deviceId));return {id:v.id,cells:[v.plate,d?.display_name||d?.device_uid||'단말 정보 확인 필요',timeLabel(d?.last_seen_at)]};
        })}/> : <OverviewTable data={data} kind={['today','unassigned'].includes(view)?'orders':'shipments'} rows={rows||[]} open={open}/>}
      <div className="fr-actions"><FreightButton onClick={()=>setView('')}>닫기</FreightButton>
        <FreightButton primary onClick={()=>onPage(selectedTask?.[3]||{today:'cargo-orders',unassigned:'cargo-dispatch',moving:'cargo-shipments',schedule:'cargo-schedule',attention:'cargo-integrations',activity:'cargo-shipments'}[view])}>관련 업무 열기</FreightButton></div>
    </div></BusinessDrawer>}
  </div>;
}

export default function FreightDashboard(props) {
  return <FreightRecordActions {...props}>{actions=><DashboardView {...props} actions={actions}/>}</FreightRecordActions>;
}
