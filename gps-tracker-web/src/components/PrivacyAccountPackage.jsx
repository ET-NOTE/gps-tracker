import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {saveBlob} from '../lib/fileDownload';
import {deliveryState} from './PrivacyDelivery';

const date=x=>new Date(x).toLocaleString('ko-KR');
const ext=m=>({'application/pdf':'pdf','image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif'}[m]||'bin');
const actions={document_review:'서류 검토 응답 생성',issued:'발급',revoked:'회수',account_prepared:'계정 자료 응답 생성',document_prepared:'서류 응답 생성'};
const sections={contact_settings:'추가 연락처·화면·알림 설정',transactions:'결제·포인트·USIM 충전·구독 요약',activity_metadata:'채팅·AI 이용 이력 (본문 제외)',location_facts:'위치정보 수집·이용·제공사실 (좌표 제외)'};
// The facts period is chosen and shown in Korean calendar days.
const DAY=86400000,KST=9*3600000,FACTS_DAYS=366;
const kstDay=x=>new Date(new Date(x).getTime()+KST).toISOString().slice(0,10);
const dayStart=day=>new Date(`${day}T00:00:00+09:00`);
export const factsPeriod=(from,until)=>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(until))return null;
 const start=dayStart(from),end=new Date(dayStart(until).getTime()+DAY);
 if(Number.isNaN(start.getTime())||Number.isNaN(end.getTime())||end<=start||end-start>FACTS_DAYS*DAY||start>=new Date())return null;
 return {facts_from:start.toISOString(),facts_until:end.toISOString()};
};
// The stored end is the moment of issue when the last day was not over yet.
const factsLabel=p=>p.facts_from&&p.facts_until?` ${kstDay(p.facts_from)}~${kstDay(new Date(p.facts_until).getTime()-1)}`:'';
const coverage=p=>['기본정보·요청 처리이력',...(p.sections||[]).map(s=>(sections[s]||'담당자 확인 필요')+(s==='location_facts'?factsLabel(p):''))].join(' / ');
export function PersonalAccountPackages({request}) {
 const q=useQuery({queryKey:['privacy-account-packages',request.id,request.revision],queryFn:()=>api.privacyAccountPackages(request.id),retry:false});
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 async function download(p,d){setBusy(true);setError('');setMessage('');try{const file=await api.privacyPackageFile(p.id,password,d?.id);await saveBlob(file.blob,d?`personal-document-${d.id}.${ext(d.mime)}`:file.filename);setMessage('자료 저장을 요청했습니다. 다운로드 목록을 확인해 주세요.');}catch(e){setError(e.message);}finally{setPassword('');setBusy(false);}}
 const available=p=>deliveryState(p)==='다운로드 가능'&&!['cancelled','rejected'].includes(request.status);
 return <section className="rights-delivery">
  {q.error&&<p role="alert">계정 자료 목록을 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>}
  {!!q.data?.length&&<><h4>계정 정보·처리이력·개인 서류</h4>
   <p>발급별 포함 범위를 확인해 주세요. 계정 자료는 JSON 파일로, 검토된 개인 서류는 각각 제공합니다. 위치 기록·회사 자료·채팅 및 AI 본문은 별도 검토 대상입니다. 위치정보 수집·이용·제공사실은 표시된 기간에 남아 있는 기록이며 좌표는 포함하지 않습니다.</p>
   {q.data.some(available)&&<label>계정 자료 다운로드용 현재 비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>}
   {q.data.map(p=><div className="rights-request" key={p.id}><p>{deliveryState(p)} · 만료 {date(p.expires_at)}</p>
    <p>포함 범위: {coverage(p)}</p>
    {available(p)&&<button disabled={busy||!password} onClick={()=>download(p)}>계정 자료 내려받기</button>}
    {p.documents.map(d=><div className="rights-package-file" key={d.id}><span>{d.filename}</span>{available(p)&&<button disabled={busy||!password} onClick={()=>download(p,d)}>서류 내려받기</button>}</div>)}
   </div>)}<p>현재 남아 있는 지정 범위 자료입니다. 저장한 파일은 서버에서 회수할 수 없습니다.</p></>}
  {error&&<p role="alert" className="rights-error">{error}</p>}{message&&<p role="status">{message}</p>}
 </section>;
}
export function AdminAccountPackages({request,refresh}) {
 const enabled=['in_review','needs_information'].includes(request.status)&&!!request.due_at;
 const q=useQuery({queryKey:['admin-account-packages',request.id,request.revision],queryFn:()=>api.adminPrivacyAccountPackages(request.id),retry:false});
 const options=useQuery({queryKey:['admin-personal-documents',request.id,request.revision],queryFn:()=>api.privacyPersonalDocuments(request.id),enabled,retry:false});
 const [reviewed,setReviewed]=useState({}),[selected,setSelected]=useState([]),[extraSections,setExtraSections]=useState([]),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [factsFrom,setFactsFrom]=useState(()=>kstDay(Date.now()-180*DAY)),[factsUntil,setFactsUntil]=useState(()=>kstDay(Date.now()));
 const wantsFacts=extraSections.includes('location_facts'),period=wantsFacts?factsPeriod(factsFrom,factsUntil):null;
 async function review(d){setBusy(true);setError('');try{const file=await api.reviewPrivacyDocument(request.id,d.id);await saveBlob(file.blob,`review-${d.id}.${ext(d.mime)}`);if(!file.sha256)throw new Error('파일 확인값을 받지 못했습니다. 다시 확인해 주세요.');setReviewed(v=>({...v,[d.id]:file.sha256}));setConfirmed(false);}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function issue(e){e.preventDefault();setBusy(true);setError('');try{await api.issuePrivacyAccountPackage(request.id,{revision:request.revision,confirmed,sections:extraSections,...(period||{}),documents:selected.map(id=>({id,sha256:reviewed[id]}))});setSelected([]);setExtraSections([]);setReviewed({});setConfirmed(false);await refresh();await q.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function revoke(id){setBusy(true);setError('');try{await api.revokePrivacyAccountPackage(id);await q.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="rights-impact"><h3>계정 정보·개인 서류 제공</h3>
  <p>계정 기본정보와 공개된 요청 처리이력을 제공합니다. 개인 서류는 내려받아 본인 자료인지 확인한 뒤 선택하세요. 회사 연결·소유권 변경·공동 파일은 자동 제공에서 제외합니다.</p>
  {enabled?<form onSubmit={issue}><fieldset disabled={busy}>
   <p>기본 제공: 이름·이메일·기본 연락처·가입/수정 시각, 개인정보 요청과 공개 처리이력. 첨부를 선택하지 않아도 발급할 수 있습니다.</p>
   {options.data?.items.map(d=><div className="rights-package-file" key={d.id}><label className="rights-confirm"><input type="checkbox" disabled={!reviewed[d.id]} checked={selected.includes(d.id)} onChange={e=>{setSelected(e.target.checked?[...selected,d.id]:selected.filter(x=>x!==d.id));setConfirmed(false);}}/><span>{d.filename} · {Math.ceil(d.size_bytes/1024)} KB</span></label><button type="button" onClick={()=>review(d)}>{reviewed[d.id]?'다시 내려받아 검토':'서류 내려받아 검토'}</button></div>)}
   {options.data?.items.length===0&&<p>자동 제공 가능한 개인 서류가 없습니다. 사진·회사 서류 등은 별도로 검토합니다.</p>}
   {options.data?.more&&<p>후보가 100개를 넘습니다. 나머지 서류는 별도 검토가 필요합니다.</p>}
   <h4>추가 제공 범위</h4>
   {Object.entries(sections).map(([key,label])=><label className="rights-confirm" key={key}><input type="checkbox" name={key} checked={extraSections.includes(key)} onChange={e=>{setExtraSections(e.target.checked?[...extraSections,key]:extraSections.filter(s=>s!==key));setConfirmed(false);}}/>{label}</label>)}
   {wantsFacts&&<><h4>수집·이용·제공사실 기간</h4><div className="rights-date-row">
    <label>시작일 (한국시간)<input type="date" name="facts_from" value={factsFrom} max={factsUntil} onChange={e=>{setFactsFrom(e.target.value);setConfirmed(false);}}/></label>
    <label>종료일 (포함)<input type="date" name="facts_until" value={factsUntil} min={factsFrom} max={kstDay(Date.now())} onChange={e=>{setFactsUntil(e.target.value);setConfirmed(false);}}/></label></div>
    {!period&&<p role="alert" className="rights-error">과거에 시작하는 366일 이내의 기간을 선택해 주세요.</p>}
    <p>선택한 기간(한국 날짜)에 남아 있는 기록을 좌표·주소 없이 제공합니다. 수집은 날짜·단말기·수집 방법별 건수, 이용은 구역 출입·첫 위치 확인 사건과 AI 분석, 제공은 공유 링크·위치 파일 제공·회사 연결 변동입니다. 종료일이 오늘이면 발급 시각까지입니다.</p>
    <p>지도·이력 조회, 공유 링크 열람자, 회사·운영자의 조회처럼 건별 기록이 없는 처리는 자료 안에 '기록되지 않는 처리'로 안내됩니다. 회사 차량 연결 이력이 있는 단말기와 파기된 SIM은 제외하고 개수만 표시합니다. 기간의 자료가 많으면 다운로드가 중단되므로 기간을 나누어 발급하세요.</p>
   </>}
   <p>결제 비밀값·내부 메모·채팅 및 AI 본문은 포함하지 않습니다. 장치별 설정·회사 자료 등은 별도 검토합니다. 추가 연락처는 200개, 각 거래·이용 이력은 1,000건을 넘으면 다운로드가 중단되어 별도 제공이 필요합니다.</p>
   <p>서류 최대 20개 · 파일당 10MB · 발급 후 24시간. 자료는 다운로드 시점 기준입니다. 발급은 요청 전체의 제공 완료를 뜻하지 않습니다.</p>
   <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>요청 범위와 선택한 서류의 내용을 확인했으며, 타인 정보 없이 제공할 수 있습니다.</label>
   <button type="submit" disabled={!confirmed||!!options.error||options.isPending||(wantsFacts&&!period)}>계정 자료 발급</button>
  </fieldset></form>:<p>검토 상태와 처리 기한을 지정하면 자료를 발급할 수 있습니다.</p>}
  {(error||q.error||options.error)&&<p role="alert" className="rights-error">{error||q.error?.message||options.error?.message}</p>}
  {q.data?.items.map(p=><div className="rights-request" key={p.id}><p>계정 자료 #{p.id} · 개인 서류 {p.documents.length}개 · {deliveryState(p)} · 만료 {date(p.expires_at)}</p><p>포함 범위: {coverage(p)}</p>{deliveryState(p)==='다운로드 가능'&&<button disabled={busy} onClick={()=>revoke(p.id)}>계정 자료 권한 회수</button>}</div>)}
  {!!q.data?.events.length&&<details><summary>계정 자료 제공 이력</summary>{q.data.events.map(e=><p key={e.id}>{date(e.created_at)} · {actions[e.action]}</p>)}<p>응답 생성은 검토·저장 완료를 증명하지 않습니다.</p></details>}
 </section>;
}
