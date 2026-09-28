import { api } from './api';
import { authScope, AUTH_CHANGED } from './authSession';
import { createShieldMonitorController } from './lib/shieldMonitorController';

export function initShieldMonitor() {
  'use strict';
  const $ = id => document.getElementById(id);
  let data = null, timer = null, fetchedAt = 0, failed = false, pickerKey = '';
  const fmt = new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const time = value => value && Number.isFinite(Date.parse(value)) ? fmt.format(new Date(value)) : '—';
  const voltage = value => typeof value === 'number' && value >= 0 && value <= 20000 ? (value/1000).toFixed(3)+' V' : '—';
  const signal = value => value >= 0 && value <= 31 && value !== null ? String(value) : '미확인';
  const network = value => ({1:'홈망 등록',5:'로밍 등록',2:'망 탐색',3:'등록 거절',0:'미등록'})[value] || '미확인';
  const duration = seconds => !Number.isFinite(seconds) || seconds < 0 ? '—' : seconds < 60 ? Math.floor(seconds)+'초' : seconds < 3600 ? Math.floor(seconds/60)+'분 '+Math.floor(seconds%60)+'초' : Math.floor(seconds/3600)+'시간 '+Math.floor(seconds%3600/60)+'분';
  function updateStatus() {
    if (!data) return;
    const age = data.last_seen_at ? Math.max(0,(Date.parse(data.server_now)-Date.parse(data.last_seen_at)+Date.now()-fetchedAt)/1000) : null;
    $('age').textContent = age === null ? '수신 전' : duration(age)+' 전';
    $('status').className = 'status'+(failed ? ' error' : age !== null && age < 180 ? ' live' : ' warn');
    $('status').textContent = failed ? '조회 실패 · 이전 값' : age === null ? '수신 대기' : age < 180 ? '최근 수신 정상' : '수신 지연';
  }
  function chart(items) {
    const root=$('chart'); root.replaceChildren();
    const points=items.filter(x=>typeof x.pv_mv==='number' && x.pv_mv>=0 && x.pv_mv<=20000).slice().reverse();
    const node=(name,attrs,text) => {const n=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [k,v] of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;root.append(n);return n;};
    if(!points.length){node('text',{x:520,y:82,'text-anchor':'middle'},'PV 전압이 수신되면 그래프가 표시됩니다.');$('chartNote').textContent='아직 전압 기록이 없습니다.';return;}
    const values=points.map(p=>p.pv_mv/1000),lo=Math.min(...values)-.025,hi=Math.max(...values)+.025;
    const start=Date.parse(points[0].recorded_at),end=Date.parse(points.at(-1).recorded_at);
    const x=p=>end===start?535:55+(Date.parse(p.recorded_at)-start)/(end-start)*960;
    const y=p=>125-(p.pv_mv/1000-lo)/(hi-lo)*105;
    [0,.5,1].forEach(t=>{const yy=125-t*105;node('line',{x1:55,y1:yy,x2:1015,y2:yy,stroke:'#e7eeea'});node('text',{x:45,y:yy+4,'text-anchor':'end'},(lo+t*(hi-lo)).toFixed(2));});
    node('polyline',{points:points.map(p=>x(p)+','+y(p)).join(' '),fill:'none',stroke:'var(--primary)','stroke-width':2.5,'stroke-linejoin':'round'});
    const last=points.at(-1);node('circle',{cx:x(last),cy:y(last),r:4,fill:'var(--primary)'});
    node('text',{x:55,y:153},time(points[0].recorded_at));node('text',{x:1015,y:153,'text-anchor':'end'},time(last.recorded_at));
    $('chartNote').textContent=points.length+'개 수신값 · 최저 '+Math.min(...values).toFixed(3)+' V / 최고 '+Math.max(...values).toFixed(3)+' V';
  }
  function render() {
    const items=data.items, latest=items[0];
    $('seen').textContent=time(data.last_seen_at);
    $('count').textContent=Number(data.count_24h).toLocaleString('ko-KR')+'건';
    $('pv').textContent=latest?voltage(latest.pv_mv):'—';
    $('gps').textContent=latest ? latest.fix ? '위치 확보' : '측위 대기' : '수신 전';
    $('gpsHint').textContent=latest?.fix ? '품질 기준을 통과한 위치가 수신됐습니다' : '좌표가 없어도 상태 보고는 수신됩니다';
    $('network').textContent=latest?network(latest.reg):'—';$('signal').textContent=latest?signal(latest.csq):'—';$('build').textContent=latest?.build_tag || '—';
    const body=$('rows');body.replaceChildren();
    items.forEach((r,i)=>{const tr=document.createElement('tr');const gap=items[i+1]?(Date.parse(r.recorded_at)-Date.parse(items[i+1].recorded_at))/1000:null;
      [time(r.recorded_at),gap===null?'—':duration(gap),duration(r.device_uptime_s),voltage(r.pv_mv),r.fix?'위치 확보':'측위 대기',r.point_count ?? (r.fix?1:0),signal(r.csq),network(r.reg),r.build_tag||'—'].forEach((value,j)=>{const td=document.createElement('td');td.textContent=value;if(j===4 && r.fix)td.className='fix';tr.append(td);});body.append(tr);});
    $('empty').hidden=items.length>0;$('empty').textContent=data.available?'최근 24시간 수신 기록이 없습니다. 단말의 전원과 통신 상태를 확인해 주세요.':'아직 시험 장치의 수신 기록이 없습니다.';
    $('download').disabled=!items.length;chart(items);updateStatus();
  }
  function schedule(){clearTimeout(timer);if($('auto').checked && !document.hidden)timer=setTimeout(()=>controller.refresh(),10000);}
  function resetDisplay(message) {
    for (const id of ['age','seen','count','pv','gps','network','signal','build']) $(id).textContent='—';
    $('gpsHint').textContent='통신 수신과 위치 확보는 별도입니다';
    $('rows').replaceChildren();$('chart').replaceChildren();$('chartNote').textContent='장치의 수신 기록을 확인합니다.';
    $('empty').hidden=false;$('empty').textContent=message;$('download').disabled=true;
    $('status').className='status';$('status').textContent=message.includes('소유한 쉴드')?'등록된 쉴드 없음':message;
    $('updated').textContent='';
  }
  const controller=createShieldMonitorController({
    api,getScope:authScope,
    preferredId:Number(new URLSearchParams(location.search).get('device')) || null,
    publicView:new URLSearchParams(location.search).get('view')==='public',
    fetchPublic:async signal=>{
      const response=await fetch('/arduino-shield/data',{cache:'no-store',signal});
      if(!response.ok)throw Object.assign(new Error('public status'),{status:response.status});
      return response.json();
    },
    onChange:state=>{
      data=state.data;fetchedAt=state.fetchedAt;failed=Boolean(state.error);
      const owned=state.mode==='owned',selected=state.devices.find(d=>d.id===state.selectedId);
      const select=$('device');
      const option=(value,label)=>{const o=document.createElement('option');o.value=String(value);o.textContent=label;select.append(o);};
      // Polling must not replace options while the user is using the native picker.
      const nextPickerKey=JSON.stringify([owned,state.listLoading,state.selectedId==null,state.devices]);
      if(nextPickerKey!==pickerKey){
        pickerKey=nextPickerKey;select.replaceChildren();
        if(!owned)option('public','공개 시험 장치 · uno-shield-test');
        else if(!state.devices.length)option('',state.listLoading?'내 쉴드 목록을 불러오는 중':'소유한 쉴드가 없습니다');
        else { if(state.selectedId==null)option('','쉴드를 선택해 주세요');state.devices.forEach(d=>option(d.id,(d.display_name || '이름 없는 쉴드')+' · '+d.device_uid)); }
      }
      select.value=owned?String(state.selectedId??''):'public';select.disabled=!owned || state.listLoading || !state.devices.length;
      $('selectedUid').textContent=selected?.device_uid || (owned?'내 계정의 쉴드':'uno-shield-test');
      $('scopeNote').textContent=owned?'내 계정에 귀속된 쉴드와 내 계정으로 수신된 상태만 표시합니다.':'지정된 시험 장치의 상태를 공개 조회하고 있습니다.';
      $('authLink').textContent=authScope()==='anonymous'?'로그인하고 내 쉴드 보기':owned?'공개 시험 장치 보기':'내 쉴드 보기';
      $('authLink').href=authScope()==='anonymous'?'/login?next=%2Farduino-shield':owned?'/arduino-shield?view=public':'/arduino-shield';
      $('error').hidden=!state.error;$('error').textContent=state.error || '';
      $('refresh').disabled=state.loading || state.listLoading;
      if(data){$('updated').textContent='마지막 갱신 '+time(data.server_now);render();}
      else resetDisplay(state.error?'조회 실패':state.loading || state.listLoading?'불러오는 중':owned && !state.devices.length?'소유한 쉴드가 없습니다. 장치를 계정에 등록한 뒤 새로고침해 주세요.':'쉴드를 선택해 주세요.');
      clearTimeout(timer);if(!state.loading && !state.listLoading)schedule();
    },
  });
  $('device').addEventListener('change',()=>{
    const id=Number($('device').value);const url=new URL(location.href);url.searchParams.set('device',String(id));url.searchParams.delete('view');history.replaceState(null,'',url);
    controller.select(id);
  });
  $('refresh').addEventListener('click',()=>controller.refreshDevices());$('auto').addEventListener('change',schedule);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(timer);else if($('auto').checked)controller.refreshDevices();});
  let currentScope=authScope();
  const syncSession=()=>{const next=authScope();if(next!==currentScope){currentScope=next;controller.refreshDevices();}};
  window.addEventListener(AUTH_CHANGED,syncSession);window.addEventListener('storage',syncSession);
  const ageTimer=setInterval(updateStatus,1000);
  window.addEventListener('pagehide',()=>{controller.dispose();clearTimeout(timer);clearInterval(ageTimer);window.removeEventListener(AUTH_CHANGED,syncSession);window.removeEventListener('storage',syncSession);},{once:true});
  // A restored page must recheck its account and start fresh requests/timers.
  window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
  $('download').addEventListener('click',()=>{if(!data)return;const escape=value=>{let s=String(value??'');if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};const rows=[['기록시각(UTC)','가동초','PV_mV','GPS_fix','좌표수','CSQ','등록상태','펌웨어'],...data.items.map(r=>[r.recorded_at,r.device_uptime_s,r.pv_mv,r.fix,r.point_count ?? (r.fix?1:0),r.csq,r.reg,r.build_tag])];const blob=new Blob(['\ufeff'+rows.map(row=>row.map(escape).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=String(data.device_uid).replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  controller.refreshDevices();
}

initShieldMonitor();
