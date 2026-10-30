import React,{useEffect,useState} from 'react';
import {api} from '../../api';
import {Modal,FormField,Input,Select} from '../ui';
import {BusinessButton,BusinessError,BusinessEmpty} from './BusinessWorkspace';
import {kstDateTime} from '../../lib/businessExport';
import {tripAssignmentRef} from '../../lib/tripAssignments';
import {qualityLabel,zeroLabels,endBasisLabels,correctionLabels,kstInput} from '../../lib/tripQuality';
import './FleetTripQuality.css';
const km=t=>t.distance_m==null?'거리 없음':`${(t.distance_m/1000).toFixed(3)} km`;
const summary=t=>`${kstDateTime(t.started_at)} ~ ${kstDateTime(t.ended_at)||'종료 미수신'} · ${km(t)}`;
export function TripEvidence({vehicle,trip,from,to,onClose,onCorrect,canManage}){
 const[data,setData]=useState(null),[error,setError]=useState('');
 useEffect(()=>{let live=true;api.tripEvidence(vehicle.id,{from,to,key:tripAssignmentRef(trip)}).then(v=>{if(live)setData(v);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[vehicle.id,trip,from,to]);
 const q=trip.quality||{};
 return <Modal open title="운행 근거" size="xl" onClose={onClose} footer={<><BusinessButton onClick={onClose}>닫기</BusinessButton>{canManage&&!trip.correction_id&&trip.allocation_status==='assigned'&&q.status!=='running'&&<BusinessButton primary onClick={onCorrect}>기록 검토·보정</BusinessButton>}</>}><div className="fleet-quality">
 <p><strong>{qualityLabel(trip)}</strong> · {summary(trip)}</p><p className="business-note">{endBasisLabels[q.end_basis]}{q.source_changed?' · 보정 후 원본이 변경됨 · 복원 후 다시 검토해 주세요.':''}</p>
 {zeroLabels[q.zero_reason]&&<p>{zeroLabels[q.zero_reason]}</p>}{error&&<BusinessError>{error}</BusinessError>}{!data&&!error&&<p>GPS 근거를 불러오는 중…</p>}
 {data&&<><div className="fleet-quality-metrics"><div>유효 좌표<strong>{data.point_count.toLocaleString()}개</strong></div><div>원본 구간 계산<strong>{(data.calculated_distance_m/1000).toFixed(3)} km</strong></div><div>10분 초과 공백<strong>{q.gap_count??data.gaps.length}개</strong></div></div><p className="business-note">{data.method}</p>
 <details><summary>GPS 좌표 {data.sampled?'(일부 대표점)':''}</summary><div className="fleet-quality-scroll"><table><thead><tr><th>수신 시각 (KST)</th><th>위도</th><th>경도</th></tr></thead><tbody>{data.points.map((p,i)=><tr key={i}><td>{kstDateTime(p[0])}</td><td>{p[1].toFixed(6)}</td><td>{p[2].toFixed(6)}</td></tr>)}</tbody></table></div></details>
 <details><summary>기상·절전 신호 ({data.events.length}개{data.events.length===100?' · 최대 100개':''})</summary>{data.events.map((e,i)=><p key={i}>{kstDateTime(e[1])} · {e[0]==='wake'?'기상':'절전 진입'}</p>)}</details>
 <details open={data.gaps.length>0}><summary>수신 공백 {data.gaps.length===50?'(최근 조회 구간의 첫 50개)':''}</summary>{data.gaps.length?data.gaps.map((g,i)=><p key={i}>{kstDateTime(g.from)} ~ {kstDateTime(g.to)} · {Math.round(g.seconds/60)}분</p>):<p className="business-note">10분을 넘는 좌표 간격이 없습니다.</p>}</details></>}
 </div></Modal>;
}
export function TripCorrection({vehicle,trips,from,to,onClose,onSaved}){
 const first=trips[0],isMerge=trips.length===2;
 const[f,setF]=useState({action:isMerge?'merge':first.ended_at?'confirm':'adjust',started_at:kstInput(first.started_at),ended_at:kstInput(first.ended_at||first.quality?.last_fix_at),split_at:'',distance_km:'',reason:''});
 const[preview,setPreview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const change=(k,v)=>{setF(p=>({...p,[k]:v}));setPreview(null);setError('');};
 async function run(apply){setBusy(true);setError('');try{const time=s=>s?new Date(`${s}+09:00`).toISOString():null;const body={from,to,trips:trips.map(tripAssignmentRef),action:f.action,reason:f.reason,started_at:f.action==='adjust'?time(f.started_at):null,ended_at:f.action==='adjust'?time(f.ended_at):null,split_at:f.action==='split'?time(f.split_at):null,distance_m:f.action==='adjust'&&f.distance_km!==''?Number(f.distance_km)*1000:null,...(apply?{preview_token:preview.preview_token}:{})};const result=await api.correctTrips(vehicle.id,body);if(apply)onSaved();else setPreview(result);}catch(e){setPreview(null);setError(e.message);}finally{setBusy(false);}}
 return <Modal open title={isMerge?'운행 병합':'운행 검토·보정'} size="lg" onClose={busy?undefined:onClose} closeOnBackdrop={false} footer={<><BusinessButton disabled={busy} onClick={onClose}>취소</BusinessButton><BusinessButton primary disabled={busy||f.reason.trim().length<2} onClick={()=>run(!!preview)}>{busy?'처리 중…':preview?'확인한 내용 적용':'변경 미리보기'}</BusinessButton></>}><div className="fleet-quality">
 <p className="business-note">원본 GPS와 신호는 유지되며, 보고서에 적용할 사본을 만듭니다. 이력에서 원본으로 복원할 수 있습니다.</p>
 <fieldset disabled={busy}><FormField label="작업"><Select value={f.action} onChange={e=>change('action',e.target.value)}>{isMerge?<option value="merge">인접 운행 병합</option>:<><option value="confirm" disabled={!first.ended_at}>내용 확인 후 확정</option><option value="adjust">시각·거리 보정</option><option value="split" disabled={!first.ended_at}>두 구간으로 분할</option></>}</Select></FormField>
 {f.action==='adjust'&&<><div className="business-datetime-fields"><FormField label="시작 (한국 시간)"><Input type="datetime-local" step="1" value={f.started_at} onChange={e=>change('started_at',e.target.value)}/></FormField><FormField label="종료 (한국 시간)"><Input type="datetime-local" step="1" value={f.ended_at} onChange={e=>change('ended_at',e.target.value)}/></FormField></div><FormField label="보정 거리 (km, 선택)"><Input type="number" step="0.001" min="0" max="10000" placeholder="비우면 해당 구간 GPS로 계산" value={f.distance_km} onChange={e=>change('distance_km',e.target.value)}/></FormField><p className="business-note">시각은 원본 범위 안에서 조정합니다. 종료 미수신 기록은 마지막 GPS 수신 시각까지만 지정할 수 있습니다.</p></>}
 {f.action==='split'&&<><FormField label="나눌 시각 (한국 시간)"><Input type="datetime-local" step="1" value={f.split_at} onChange={e=>change('split_at',e.target.value)}/></FormField><p className="business-note">각 구간 GPS로 거리를 다시 계산합니다. 경계 사이의 거리는 빠질 수 있으며, 기존 용무·운전자·주유비는 첫 구간에만 남습니다.</p></>}
 {isMerge&&<p className="business-note">같은 단말기 연결 구간의 인접 운행만 병합합니다. 운전자·용무·주유비가 입력된 기록은 병합하지 않습니다.</p>}
 <FormField label="확인·보정 사유"><Input required minLength={2} maxLength={500} value={f.reason} placeholder="예: 도착 시각과 계기판 거리 확인" onChange={e=>change('reason',e.target.value)}/></FormField></fieldset>
 {error&&<BusinessError>{error}</BusinessError>}{preview&&<section aria-label="보정 미리보기"><h3>변경 전</h3>{preview.before.map((t,i)=><p key={i}>{summary(t)}</p>)}<h3>변경 후 · 확정</h3>{preview.after.map((t,i)=><p key={i}>{summary(t)}</p>)}<p className="business-note">{preview.note}</p></section>}
 </div></Modal>;
}
export function TripCorrectionHistory({vehicle,onClose,onRestored}){
 const[rows,setRows]=useState(null),[error,setError]=useState(''),[restore,setRestore]=useState(null),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
 const load=()=>api.tripCorrectionHistory(vehicle.id).then(v=>setRows(v.rows)).catch(e=>setError(e.message));
 useEffect(()=>{let live=true;api.tripCorrectionHistory(vehicle.id).then(v=>{if(live)setRows(v.rows);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[vehicle.id]);
 async function run(){setBusy(true);setError('');try{await api.restoreTripCorrection(vehicle.id,restore,{reason});setRestore(null);setReason('');await load();onRestored();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal open title="운행 보정 이력" size="xl" onClose={busy?undefined:onClose}><div className="fleet-quality"><p className="business-note">최근 100건 · 보정 전후와 복원 사유를 보존합니다. 복원은 현재 원본을 다시 표시하며 이후 작성한 용무·주유비는 삭제하지 않습니다.</p>{error&&<BusinessError>{error}</BusinessError>}{rows===null&&!error?<p>불러오는 중…</p>:!rows?.length?<BusinessEmpty title="보정 이력이 없습니다."/>:rows.map(r=><article className="fleet-quality-history" key={r.id}><header><strong>{correctionLabels[r.action]} · {r.reverted_at?'원본 복원됨':'적용 중'}</strong><span>{kstDateTime(r.created_at)} · {r.actor_name||'계정 삭제됨'}</span></header><p>{r.reason}</p><details><summary>변경 전후</summary><h4>원본</h4>{r.sources.map((t,i)=><p key={i}>{summary(t)}</p>)}<h4>보정</h4>{r.outputs.map((t,i)=><p key={i}>{summary(t)}</p>)}</details>{r.reverted_at?<p className="business-note">{kstDateTime(r.reverted_at)} · {r.reverted_by_name||'계정 삭제됨'} · {r.revert_reason}</p>:restore===r.id?<><FormField label="원본 복원 사유"><Input disabled={busy} value={reason} maxLength={500} onChange={e=>setReason(e.target.value)}/></FormField><BusinessButton disabled={busy} onClick={()=>setRestore(null)}>취소</BusinessButton><BusinessButton primary disabled={busy||reason.trim().length<2} onClick={run}>원본으로 복원</BusinessButton></>:<BusinessButton onClick={()=>{setRestore(r.id);setReason('');}}>원본 복원</BusinessButton>}</article>)}</div></Modal>;
}
