import React,{useRef,useState} from 'react';
import {api} from '../../api';
import {Modal,Button} from '../ui';
import {parseStaffCsv,staffCsvTemplate} from '../../lib/staffImport';
import {saveBlob} from '../../lib/fileDownload';

export default function FleetStaffImport({onClose,onSaved}){
 const [rows,setRows]=useState(null),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[done,setDone]=useState(false);
 const working=useRef(false);
 async function run(fn){if(working.current)return;working.current=true;setBusy(true);setError('');try{await fn();}catch(e){setError(e.message||'파일을 처리하지 못했습니다.');}finally{working.current=false;setBusy(false);}}
 async function choose(file){setPreview(null);setRows(null);setDone(false);if(!file)return;await run(async()=>{
  if(file.size>1024*1024)throw Error('1MB 이하의 CSV 파일을 선택하세요.');
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw Error('CSV UTF-8 형식으로 저장한 파일을 선택하세요.');}
  const data=parseStaffCsv(text);setRows(data);setPreview(await api.importFleetStaff({rows:data}));
 });}
 async function confirm(){await run(async()=>{try{const result=await api.importFleetStaff({rows,confirm:true,token:preview.token});setPreview(result);setDone(true);onSaved();}catch(e){setPreview(null);throw e;}});}
 return <Modal open size="lg" title="사용자 일괄 등록" onClose={busy?undefined:onClose}><div className="fleet-team-form fleet-import">
  {!done&&<><p>이름·연락처·부서·직책·담당 업무를 CSV UTF-8 파일로 올려 주세요. 최대 500명입니다.</p>
   <div className="fleet-import-actions"><Button type="button" variant="ghost" disabled={busy} onClick={()=>run(()=>saveBlob(new Blob([staffCsvTemplate],{type:'text/csv;charset=utf-8'}),'사용자_등록_양식.csv'))}>CSV 양식</Button><label>CSV 파일 선택<input type="file" accept=".csv,text/csv" disabled={busy} onChange={e=>choose(e.target.files?.[0])}/></label></div>
   <p className="business-note">부서·직책은 미리 등록된 이름을 입력하세요. 신규 사용자는 일반 권한·운행 차량 미지정으로 등록됩니다. 등록 후 차량을 배정하고 초대할 수 있습니다.</p>
   <details><summary>중복 처리 기준</summary><p>이름과 연락처가 같은 행은 제외하며 기존 정보를 유지합니다. 연락처의 공백·하이픈·괄호는 비교에서 제외합니다. 연락처가 없으면 이름이 같은 빈 연락처 등록만 중복입니다. 같은 연락처에 다른 이름이 있으면 오류로 표시합니다. 오류가 하나라도 있으면 저장하지 않습니다.</p></details></>}
  {busy&&<p role="status">{preview?'등록 중…':'미리보기 확인 중…'}</p>}
  {error&&<p role="alert" className="business-error">{error}</p>}
  {preview&&<><p role="status"><strong>{done?`${preview.created.length}명 등록 완료`:`등록 ${preview.ready}명`}</strong> · 중복 제외 {preview.skipped}명{!done&&` · 오류 ${preview.errors}명`}</p>
   <div className="fleet-import-table" tabIndex="0" role="region" aria-label="사용자 등록 미리보기"><table className="fleet-asset-table"><thead><tr>{['행','이름','연락처','부서·직책','결과'].map(s=><th key={s}>{s}</th>)}</tr></thead><tbody>{preview.rows.map(r=><tr key={r.row}><td>{r.row}</td><td>{r.name||'—'}</td><td>{r.phone||'—'}</td><td>{[r.department,r.position].filter(Boolean).join(' · ')||'—'}</td><td><span className={`business-badge ${r.status==='error'?'urgent':r.status==='ready'?'good':''}`}>{r.status==='error'?'수정 필요':r.status==='skip'?'제외':done?'등록됨':'등록 가능'}</span><small>{r.errors.join(' ')||r.message}</small></td></tr>)}</tbody></table></div></>}
  <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>{done?'닫기':'취소'}</Button>{!done&&(preview?<Button disabled={busy||preview.errors>0||preview.ready===0} onClick={confirm}>{preview.ready}명 등록</Button>:rows&&<Button disabled={busy} onClick={()=>run(async()=>setPreview(await api.importFleetStaff({rows})))}>미리보기 다시 확인</Button>)}</div>
 </div></Modal>;
}
