import {useId, useRef, useState} from 'react';
import Modal from '../ui/Modal';
import Icon from '../Icon';
import BatteryStatus from '../BatteryStatus';
import {deviceBattery} from '../../lib/battery';
import {terminalName} from '../../lib/corporateOverview';
import {validPosition} from '../../lib/businessWorkspace';
import {classifyDevice} from '../../colors';
import {useVisibleNow} from '../../hooks/useVisibleNow';
import DeviceReadingTime from './DeviceReadingTime';
import {SERVICES} from './platformModel';
import './portalDialogs.css';

function RenameTerminal({device,onSave,onClose}) {
  const id=useId(), lock=useRef(false);
  const [name,setName]=useState(device.display_name || ''),[note,setNote]=useState(device.note || '');
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  async function save(event) {
    event.preventDefault();
    if(lock.current || !name.trim())return;
    lock.current=true;setSaving(true);setError('');
    try {
      await onSave(device.id,{display_name:name.trim(),note:note.trim()});
      onClose();
    } catch(e) {setError(e.message || '수정 내용을 저장하지 못했습니다.');}
    finally {lock.current=false;setSaving(false);}
  }
  return <Modal open mobileForm className="pt-standard-dialog" size={530} title="단말기 수정"
    onClose={saving ? undefined : onClose} footer={<div className="pt-dialog-actions">
      <button type="button" className="pt-button" disabled={saving} onClick={onClose}>취소</button>
      <button type="submit" form={id} className="pt-button pt-primary" disabled={saving || !name.trim()}>{saving?'저장 중…':'저장'}</button></div>}>
    <form id={id} className="pt-terminal-fields" onSubmit={save}>
      <label>단말기 이름<input required maxLength={32} value={name} onChange={event=>setName(event.target.value)}/></label>
      <label>메모<textarea rows={3} maxLength={500} value={note} onChange={event=>setNote(event.target.value)}/></label>
      {error&&<p role="alert">{error}</p>}
    </form>
  </Modal>;
}

export default function PortalTerminalDetails({device,meta,scopeLabel,onClose,onMap,onSave,connection,renderAdvanced}) {
  const [editing,setEditing]=useState(false),[advanced,setAdvanced]=useState(false);
  const now=useVisibleNow(true,60000),status=classifyDevice(device,meta,now),positioned=validPosition(device);
  const services=SERVICES.filter(service=>device.portalServices?.includes(service.key)).map(service=>service.label).join(' · ');
  const location=positioned ? Number(device.last_lat).toFixed(5)+', '+Number(device.last_lng).toFixed(5) : '수신 대기';
  const rows=[
    ['등록 번호',device.device_uid || '미등록'],['이용 공간',scopeLabel],['업무 연결',services || '개인 단말기'],
    ['최근 통신',<DeviceReadingTime value={device.last_seen_at}/>],['최근 위치',<DeviceReadingTime value={device.last_fix_at}/>],['마지막 위치',location]
  ];
  return <Modal open placement="end" size={470} title={terminalName(device)} subtitle={services || '개인 단말기'} onClose={onClose}
    className="pt-standard-dialog pt-terminal-drawer" footer={<div className="pt-dialog-actions pt-detail-footer">
      <button className="pt-button" type="button" onClick={onClose}>닫기</button>
      <button className="pt-button pt-primary" type="button" onClick={()=>onMap(device.id)}>지도에서 보기</button></div>}>
    <div className="pt-terminal-overview">
      <div className="pt-terminal-states"><span className="pt-state" style={{color:status.color,background:status.background}}>{status.label}</span>
        <span className="pt-state" data-position={positioned}>{positioned?'위치 수신됨':'위치 수신 대기'}</span></div>
      {device.device_kind!=='phone' && <BatteryStatus reading={deviceBattery(device,meta)} showRuntime={false} sourceCaption/>}
      <section><h3>단말기 정보</h3><dl>{rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></section>
      <section><h3>설정</h3><div className="pt-terminal-settings"><button type="button" className="pt-button" onClick={()=>setEditing(true)}><Icon name="edit" size={15}/>이름·메모 수정</button>
        {connection}</div>
        {device.note&&<p className="pt-terminal-note">{device.note}</p>}</section>
      <details className="pt-terminal-more" onToggle={event=>setAdvanced(event.currentTarget.open)}>
        <summary>통계·수신 정보 및 단말기 관리</summary>{advanced && renderAdvanced(device)}
      </details>
    </div>
    {editing&&<RenameTerminal device={device} onSave={onSave} onClose={()=>setEditing(false)}/>}
  </Modal>;
}
