import { useState } from 'react';
import { FreightDrawer } from './FreightKit';
import { validPosition } from '../../lib/businessWorkspace';
import { deviceBattery } from '../../lib/battery';
import { terminalName } from '../../lib/corporateOverview';
import { linkTerminal } from '../../lib/freightCatalog';
import { nameOf, timeLabel } from '../../lib/freightWorkflow';
import { FleetResourceFilters, FreightBadge, FreightButton, FreightFacts, FreightForm, FreightField, FreightTable } from './FreightKit';
import { choicesFrom, OfficeFilter } from './FreightOfficeFields';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';
import { dotDateTime } from '../../lib/mockupFormat';

export function terminalState(device,policies) {
  const seen=Date.parse(device?.last_seen_at);
  if (!Number.isFinite(seen))return {state:'unknown',label:'수신 전'};
  const online=Date.now()-seen<=(Number(policies.offlineMinutes)||10)*60000;
  return online?{state:'online',label:'정상 수신'}:{state:'offline',label:'수신 확인 필요'};
}
export default function FreightDevices({data,save,devices=[],onMap,onRegisterDevice}) {
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const [view,setView]=useState(null),[search,setSearch]=useState(''),[state,setState]=useState(''),[branch,setBranch]=useState('');
  const vehicleFor=id=>data.vehicles.find(v=>String(v.deviceId)===String(id));
  const list=devices.filter(item=>{
    const vehicle=vehicleFor(item.id);
    return (!state||(state==='unassigned'?!vehicle:terminalState(item,data.policies).state===state))&&(!branch||vehicle?.branchId===branch)&&
      [terminalName(item),item.device_uid,vehicle?.plate].join(' ').toLowerCase().includes(search.toLowerCase().trim());
  });
  const dev=devices.find(d=>d.id===view?.id),vehicle=dev&&vehicleFor(dev.id);
  const battery=dev&&deviceBattery(dev);
  const close=()=>setView(null),detail=()=>setView({action:'detail',id:dev.id});
  const options=data.vehicles.filter(v=>!v.deviceId||String(v.deviceId)===String(dev?.id));
  async function change(form){
    const next=structuredClone(data);linkTerminal(next,devices,dev.id,form.get('vehicleId'));
    await save(next);detail();
  }
  return <section className="fr-section fr-resource-list"><div className="fr-toolbar"><span className="fr-toolbar-caption">수신 시각을 기준으로 통신 상태를 구분합니다.</span>{onRegisterDevice&&<FreightButton primary icon="plus" onClick={onRegisterDevice}>단말기 등록</FreightButton>}</div>
    <FleetResourceFilters query={search} onQuery={setSearch} placeholder={mockup?'단말기, 차량번호 검색':'단말기·차량번호 검색'} count={list.length} total={devices.length} onReset={()=>{setBranch('');setState('');setSearch('');}}>
      <OfficeFilter label="운영 지점" options={choicesFrom(data.branches)} value={branch} onChange={setBranch}/>
      <OfficeFilter label={mockup?'수신 상태':'수신·연결 상태'} options={{online:'정상 수신',offline:'수신 확인 필요',unknown:'수신 전',unassigned:'차량 미연결'}} value={state} onChange={setState}/>
    </FleetResourceFilters>
    <FreightTable columns={['단말기','연결 차량','운영 지점','마지막 수신',mockup?'상태':'수신 상태','배터리']} rows={list.map(item=>{
      const vehicle=vehicleFor(item.id);
      const reception=terminalState(item,data.policies),level=deviceBattery(item).percent;
      return {id:item.id,onOpen:()=>setView({action:'detail',id:item.id}),cells:[<><button className="fr-link" onClick={()=>setView({id:item.id,action:'detail'})}>{terminalName(item)}</button>{item.device_uid!==terminalName(item)&&(mockup?<span className="fr-inline-sub" title={item.device_uid}>{item.device_uid}</span>:<small>{item.device_uid}</small>)}</>,
        vehicle?.plate||(mockup?'미연결':'차량 미연결'),nameOf(data,'branches',vehicle?.branchId),mockup?(dotDateTime(item.last_seen_at)||'수신 전'):timeLabel(item.last_seen_at),(mockup?<FreightBadge tone={reception.state==='online'?'green':!vehicle?'neutral':'amber'}>{reception.state==='online'?'정상 수신':!vehicle?'미연결':'수신 확인'}</FreightBadge>:<FreightBadge tone={reception.state==='online'?'green':'neutral'}>{reception.label}</FreightBadge>),level==null?'미수신':level+'%']};
    })} empty={devices.length?'조회 조건에 맞는 단말기가 없습니다.':'계정에 등록된 단말기가 없습니다.'}/>
    {dev&&view.action==='detail'&&<FreightDrawer title="화물 단말기 상세" subtitle={terminalName(dev)} onClose={close} footer={<div className="fr-actions">
      <FreightButton onClick={close}>닫기</FreightButton>{onMap&&validPosition(dev)&&<FreightButton onClick={()=>onMap(dev.id)}>지도 보기</FreightButton>}
      <FreightButton primary onClick={()=>setView({action:'link',id:dev.id})} disabled={!data.vehicles.length}>차량 연결 관리</FreightButton></div>}>
      <FreightFacts items={[['단말기 식별자',dev.device_uid||String(dev.id)],['연결 차량',vehicle?.plate||'미연결'],['수신 상태',terminalState(dev,data.policies).label],
        ['마지막 수신',timeLabel(dev.last_seen_at)],['마지막 위치 수신',timeLabel(dev.last_fix_at)],['배터리',battery.percent==null?'미수신':battery.percent+'% · '+battery.voltage]]}/>
    </FreightDrawer>}
    {dev&&view.action==='link'&&<FreightForm title="단말기 차량 연결" subtitle={terminalName(dev)} onClose={detail} onSubmit={change}>
      <FreightField label="연결 차량" wide><select name="vehicleId" defaultValue={vehicle?.id||''}><option value="">연결 해제</option>{options.map(v=><option key={v.id} value={v.id}>{v.plate} · {v.model}</option>)}</select></FreightField>
    </FreightForm>}
  </section>;
}
