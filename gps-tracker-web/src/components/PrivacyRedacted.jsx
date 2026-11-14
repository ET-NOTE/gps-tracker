import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {saveBlob} from '../lib/fileDownload';

const kinds={chat:'상담 채팅',ai:'AI 분석'};
const date=v=>new Date(v).toLocaleString('ko-KR');
const available=d=>!d.revoked_at&&new Date(d.expires_at)>new Date();
const status=d=>d.revoked_at?'회수됨':available(d)?'다운로드 가능':'기한 만료';
export function selectedRange(text,start,end){return {start:Array.from(text.slice(0,start)).length,end:Array.from(text.slice(0,end)).length};}

export function AdminRedacted({request,refresh}) {
 const [kind,setKind]=useState('chat'),[before,setBefore]=useState(null),[source,setSource]=useState(null),[ranges,setRanges]=useState([]),[notice,setNotice]=useState(''),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const raw=useRef(null);
 const enabled=['in_review','needs_information'].includes(request.status)&&!!request.due_at;
 const sources=useQuery({queryKey:['privacy-text-sources',request.id,kind,before],queryFn:()=>api.privacyTextSources(request.id,kind,before),enabled,retry:false});
 const deliveries=useQuery({queryKey:['admin-redacted',request.id,request.revision],queryFn:()=>api.adminRedacted(request.id),retry:false});
 function invalidate(){setPreview(null);setConfirmed(false);setError('');}
 function clear(){setSource(null);setRanges([]);setNotice('');invalidate();}
 useEffect(()=>{window.addEventListener('pagehide',clear);return()=>window.removeEventListener('pagehide',clear);},[]);
 async function review(id){setBusy(true);clear();try{setSource(await api.reviewPrivacyText(request.id,kind,id));}catch(e){setError(e.message);}finally{setBusy(false);}}
 function add(){const node=raw.current;if(!node)return;const span=selectedRange(source.body,node.selectionStart,node.selectionEnd);invalidate();
  if(span.end<=span.start||ranges.length>=50||ranges.some(r=>span.start<r.end&&span.end>r.start)){setError('겹치지 않는 본문 구간을 선택해 주세요.');return;}
  setRanges([...ranges,span].sort((a,b)=>a.start-b.start));
 }
 function selection(){return {source_kind:source.source_kind,source_id:source.source_id,source_sha256:source.source_sha256,ranges,notice};}
 async function prepare(){setBusy(true);invalidate();try{setPreview(await api.previewRedacted(request.id,selection()));}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function issue(){setBusy(true);setError('');try{await api.issueRedacted(request.id,{...selection(),revision:request.revision,preview_sha256:preview.preview_sha256,confirmed});clear();await refresh();await deliveries.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function revoke(id){setBusy(true);setError('');try{await api.revokeRedacted(id);await deliveries.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="rights-impact"><h3>본문 일부 제공</h3><p>요청자의 채팅·AI 본문에서 제공할 부분만 선택하세요. 선택하지 않은 구간은 [비공개]로 표시합니다. 회사 자료·사진·영수증은 별도 검토 대상입니다.</p>
 {enabled&&<fieldset disabled={busy}><label>자료 종류<select value={kind} onChange={e=>{setKind(e.target.value);setBefore(null);clear();}}>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 {sources.isPending&&<p>자료 목록을 불러오는 중…</p>}
 {sources.data?.items.length===0&&<p>해당 본문이 없습니다.</p>}
 <div className="rights-text-sources">{sources.data?.items.map(d=><button type="button" key={d.id} disabled={!d.supported} onClick={()=>review(d.id)}>#{d.id} · {date(d.created_at)} · {d.characters.toLocaleString()}자{!d.supported?' · 분할 검토 필요':''}</button>)}</div>
 <div className="rights-heading">{before&&<button type="button" onClick={()=>{setBefore(null);clear();}}>처음</button>}{sources.data?.next&&<button type="button" onClick={()=>{setBefore(sources.data.next);clear();}}>다음 자료</button>}</div>
 {source&&<><label>검토 원문 · 제공할 부분을 드래그해 선택<textarea ref={raw} readOnly rows={8} value={source.body} className="rights-raw-text" spellCheck={false}/></label>
 <button type="button" onClick={add}>선택한 부분만 추가</button> <button type="button" onClick={clear}>원문 닫기</button>
 <p>선택 {ranges.length}/50개 · 모든 구간은 기본 비공개입니다.</p>
 {ranges.map((r,i)=><div key={`${r.start}-${r.end}`} className="rights-request"><p className="rights-text">{Array.from(source.body).slice(r.start,r.end).join('')}</p><button type="button" onClick={()=>{setRanges(ranges.filter((_,n)=>n!==i));invalidate();}}>이 구간 제외</button></div>)}
 <label>요청자에게 안내할 제공 범위·제외 사유<textarea rows={3} maxLength={1000} value={notice} onChange={e=>{setNotice(e.target.value);invalidate();}} placeholder="제공한 범위와 타인 정보 등 제외한 사유를 적어 주세요."/></label>
 <button type="button" disabled={!ranges.length||!notice.trim()} onClick={prepare}>제공본 미리보기</button>
 {preview&&<div className="rights-request"><h4>실제 제공할 본문</h4><pre className="rights-redacted-preview">{preview.text}</pre><p className="rights-text">{preview.notice}</p>
 <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 본인 확인·요청 범위·타인 정보 제외와 위 제공본을 확인했습니다.</label>
 <button type="button" disabled={!confirmed} onClick={issue}>24시간 제공 권한 발급</button></div>}
 </>}
 </fieldset>}
 {!enabled&&<p>검토 상태와 처리 기한을 지정하면 제공본을 준비할 수 있습니다.</p>}
 {(error||sources.error||deliveries.error)&&<p role="alert" className="rights-error">{error||sources.error?.message||deliveries.error?.message}</p>}
 {deliveries.data?.items.map(d=><div key={d.id} className="rights-request"><p>#{d.id} · {kinds[d.source_kind]} · {status(d)} · {date(d.expires_at)}</p><p className="rights-text">{d.notice}</p>{available(d)&&<button type="button" disabled={busy} onClick={()=>revoke(d.id)}>제공 권한 회수</button>}</div>)}
 {!!deliveries.data?.events.length&&<details><summary>검토·제공 이력</summary>{deliveries.data.events.map(e=><p key={e.id}>{date(e.created_at)} · {({source_review:'원문 확인',preview:'제공본 미리보기',issued:'발급',revoked:'회수',download_prepared:'다운로드 응답 생성'})[e.action]} · 담당 계정 {e.actor_id}</p>)}</details>}
 <p>발급·다운로드는 요청 전체의 완료를 뜻하지 않습니다. 원문 변경·삭제 시 재검토가 필요하며, 이미 내려받은 사본은 회수할 수 없습니다.</p>
 </section>;
}

export function PersonalRedacted({request}) {
 const q=useQuery({queryKey:['personal-redacted',request.id,request.revision],queryFn:()=>api.personalRedacted(request.id),retry:false});
 const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{const clear=()=>{setPassword('');setMessage('');};window.addEventListener('pagehide',clear);return()=>window.removeEventListener('pagehide',clear);},[]);
 async function download(id){setBusy(true);setError('');setMessage('');try{await saveBlob(await api.downloadRedacted(id,password),`reviewed-text-${id}.json`);setMessage('파일 저장을 요청했습니다. 다운로드 목록을 확인해 주세요.');}catch(e){setError(e.message);}finally{setPassword('');setBusy(false);}}
 const allowed=!['cancelled','rejected'].includes(request.status);
 return <section className="rights-delivery">
 {q.error&&<p role="alert">제공 자료를 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>}
 {!!q.data?.items.length&&<><h4>검토한 본문 · 일부 제공</h4><p>[비공개]는 타인 정보 등 제외한 구간입니다. 각 자료의 제공 범위·제외 사유를 확인해 주세요.</p>
 {allowed&&q.data.items.some(available)&&<label>다운로드 확인용 현재 비밀번호<input type="password" autoComplete="current-password" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>}
 {q.data.items.map(d=><div key={d.id} className="rights-request"><p>{kinds[d.source_kind]} · {status(d)} · 만료 {date(d.expires_at)}</p><p className="rights-text">{d.notice}</p>{allowed&&available(d)&&<button type="button" disabled={busy||!password} onClick={()=>download(d.id)}>검토한 본문 내려받기</button>}</div>)}
 </>}{error&&<p role="alert" className="rights-error">{error}</p>}{message&&<p role="status">{message}</p>}
 </section>;
}
