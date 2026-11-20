import {useFleetAccess} from './FleetAccess';
import React,{useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import CarImage from '../CarImage';
import {saveBlob} from '../../lib/fileDownload';
import {confirmDialog} from '../Dialog';

export default function FleetAssetMedia({asset,onChanged}) {
  const access=useFleetAccess();
  const docs=useQuery({queryKey:['fleet-documents',asset.id],queryFn:()=>api.listFleetDocuments(asset.id)});
  const [kind,setKind]=useState('registration'),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function run(action){setBusy(true);setError('');try{await action();}catch(e){setError(e.message||'처리하지 못했습니다.');}finally{setBusy(false);}}
  return <section className="fleet-asset-media"><h3>사진·서류</h3>
    <div className="fleet-asset-photo"><CarImage vehicleId={asset.id} version={asset.profile.car_image_url} alt={asset.name}/></div>
    {access.manage_vehicles&&<label className="fleet-file-label">대표 사진 변경<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)run(async()=>{if(file.size>5*1024*1024)throw new Error('사진은 최대 5MB입니다.');await api.uploadFleetPhoto(asset.id,file);onChanged();});}}/></label>}
    <div className="fleet-asset-fields"><label>서류 종류<select value={kind} onChange={e=>setKind(e.target.value)}>{[['registration','등록증'],['insurance','보험'],['inspection','검사'],['receipt','영수증'],['other','기타']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label><label>메모<input maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label></div>
    <label className="fleet-file-label">서류 첨부 · PDF·이미지, 최대 10MB<input type="file" accept=".pdf,image/jpeg,image/png,image/webp,image/gif" disabled={busy} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)run(async()=>{if(file.size>10*1024*1024)throw new Error('서류는 최대 10MB입니다.');await api.uploadFleetDocument(asset.id,{file,kind,note});setNote('');await docs.refetch();});}}/></label>
    {error&&<p role="alert" className="business-error">{error}</p>}
    {docs.error?<p role="alert">서류를 불러오지 못했습니다. <button onClick={()=>docs.refetch()}>다시 시도</button></p>:docs.isPending?<p>서류 조회 중…</p>:!docs.data.length?<p className="business-note">등록된 서류가 없습니다.</p>:docs.data.map(d=><div className="fleet-document-row" key={d.id}><span title={d.filename}>{d.filename}</span><button className="business-button" disabled={busy} onClick={()=>run(async()=>{const {blob,filename}=await api.documentDownloadUrl(d.id)();await saveBlob(blob,filename);})}>다운로드</button><button className="business-button" disabled={busy} onClick={async()=>{if(await confirmDialog({title:'서류 삭제',body:`${d.filename}을 삭제할까요?`,danger:true}))run(async()=>{await api.deleteDocument(d.id);await docs.refetch();});}}>삭제</button></div>)}
  </section>;
}
