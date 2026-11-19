import React,{useId,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {useFleetAccess} from './FleetAccess';
import CarImage from '../CarImage';
import Icon from '../Icon';
import {saveBlob} from '../../lib/fileDownload';
import {kstDateTime} from '../../lib/businessExport';
import {confirmDialog} from '../Dialog';

const documentKinds={registration:'등록증',insurance:'보험',inspection:'검사',receipt:'영수증',other:'기타'};

function FilePicker({label,accept,disabled,onFile,hintId}) {
  return <label className="business-button fleet-media-picker">
    <Icon name="upload" size={16}/>{label}
    <input type="file" aria-label={label} aria-describedby={hintId} accept={accept} disabled={disabled} onChange={event=>{
      const file=event.target.files?.[0];
      event.target.value='';
      if(file)onFile(file);
    }}/>
  </label>;
}

export default function FleetAssetMedia({asset,onChanged}) {
  const access=useFleetAccess();
  const docs=useQuery({queryKey:['fleet-documents',asset.id],queryFn:()=>api.listFleetDocuments(asset.id)});
  const [kind,setKind]=useState('registration'),[note,setNote]=useState('');
  const [attach,setAttach]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const pending=useRef(false), attachButton=useRef(null);
  const formId=useId(),photoHint=useId(),documentHint=useId();
  const photo=asset.profile?.car_image_url;

  async function run(action) {
    if(pending.current)return;
    pending.current=true;setBusy(true);setError('');
    try{await action();}
    catch(e){setError(e.message||'처리하지 못했습니다.');}
    finally{pending.current=false;setBusy(false);}
  }

  function uploadPhoto(file) {
    return run(async()=>{
      if(file.size>5*1024*1024)throw new Error('사진은 최대 5MB입니다.');
      await api.uploadFleetPhoto(asset.id,file);
      await onChanged();
    });
  }

  function attachDocument(file) {
    return run(async()=>{
      if(file.size>10*1024*1024)throw new Error('서류는 최대 10MB입니다.');
      await api.uploadFleetDocument(asset.id,{file,kind,note});
      setNote('');
      setAttach(false);
      await docs.refetch();
      attachButton.current?.focus();
    });
  }

  return <div className="fleet-asset-media">
    <section className="fleet-media-section" aria-label="대표 사진">
      <header><h3>대표 사진</h3>
        {access.manage_vehicles&&<FilePicker label={photo?'사진 변경':'사진 등록'} accept="image/jpeg,image/png,image/webp" hintId={photoHint} disabled={busy} onFile={uploadPhoto}/>}
      </header>
      {photo?<div className="fleet-media-photo"><CarImage vehicleId={asset.id} version={photo} alt={`${asset.name||'차량'} 대표 사진`}/></div>:
        <div className="fleet-media-empty"><Icon name="cam" size={23}/><span>등록된 사진이 없습니다.</span></div>}
      {access.manage_vehicles&&<p id={photoHint} className="fleet-media-hint">JPG, PNG, WebP · 최대 5MB</p>}
    </section>
    <section className="fleet-media-section" aria-label="차량 서류">
      <header><h3>차량 서류 {docs.data&&!docs.error&&<small>{docs.data.length}건</small>}</h3>
        <button ref={attachButton} type="button" className="business-button" aria-expanded={attach} aria-controls={formId} onClick={()=>setAttach(!attach)}>
          <Icon name={attach?'close':'paperclip'} size={16}/>{attach?'첨부 닫기':'서류 첨부'}
        </button>
      </header>
      <div id={formId} hidden={!attach} className="fleet-media-attach">
        <div className="fleet-asset-fields">
          <label>서류 종류<select aria-label="서류 종류" value={kind} onChange={e=>setKind(e.target.value)}>{Object.entries(documentKinds).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
          <label>메모 (선택)<input maxLength={500} value={note} onChange={e=>setNote(e.target.value)}/></label>
        </div>
        <div className="fleet-media-picker-row">
          <FilePicker label="파일 선택" accept=".pdf,image/jpeg,image/png,image/webp,image/gif" hintId={documentHint} disabled={busy} onFile={attachDocument}/>
          <p id={documentHint} className="fleet-media-hint">PDF 또는 이미지 · 최대 10MB</p>
        </div>
      </div>
      {docs.error?<p role="alert" className="business-error">서류를 불러오지 못했습니다. <button className="business-button" type="button" onClick={()=>docs.refetch()}>다시 시도</button></p>:
       docs.isPending?<p role="status" className="fleet-media-hint">서류 조회 중…</p>:
       !docs.data?.length?<div className="fleet-media-empty"><Icon name="file" size={23}/><span>등록된 서류가 없습니다.</span></div>:
       <ul className="fleet-media-documents">{docs.data.map(doc=><li key={doc.id}>
         <div className="fleet-media-document-info">
           <strong>{doc.filename}</strong>
           <span>{[documentKinds[doc.kind]||doc.kind,doc.uploaded_at&&kstDateTime(doc.uploaded_at).slice(0,10)].filter(Boolean).join(' · ')}</span>
           {doc.note&&<p>{doc.note}</p>}
         </div>
         <div className="fleet-media-document-actions">
           <button type="button" className="business-button" disabled={busy} onClick={()=>run(async()=>{const {blob,filename}=await api.documentDownloadUrl(doc.id)();await saveBlob(blob,filename);})}>다운로드</button>
           <button type="button" className="business-button" disabled={busy} onClick={async()=>{if(await confirmDialog({title:'서류 삭제',body:`${doc.filename}을 삭제할까요?`,danger:true}))run(async()=>{await api.deleteDocument(doc.id);await docs.refetch();});}}>삭제</button>
         </div>
       </li>)}</ul>}
    </section>
    {error&&<p role="alert" className="business-error">{error}</p>}
  </div>;
}
