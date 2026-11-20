import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {downloadReceipt} from '../../lib/downloadReport';
import Icon from '../Icon';
import {Modal} from '../ui';
import {BusinessButton,BusinessError} from './BusinessWorkspace';
import './expense-attachments.css';

const imageTypes=new Set(['image/jpeg','image/png','image/webp']);
const isImage=receipt=>imageTypes.has(receipt?.mime);

function useVisible(ref){
 const [visible,setVisible]=useState(false);
 useEffect(()=>{
  if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
  const observer=new IntersectionObserver(entries=>{
   if(entries.some(entry=>entry.isIntersecting)){setVisible(true);observer.disconnect();}
  },{rootMargin:'80px'});
  if(ref.current)observer.observe(ref.current);
  return ()=>observer.disconnect();
 },[ref]);
 return visible;
}

function useAttachmentDetail(expenseId,enabled=true){
 return useQuery({queryKey:['expense-detail',expenseId],queryFn:()=>api.expenseDetail(expenseId),enabled,staleTime:60000});
}

function useAttachmentImage(expenseId,receipt,enabled=true){
 const query=useQuery({
  queryKey:['expense-receipt',expenseId,receipt?.id],
  queryFn:async()=>{
   const blob=await api.downloadExpenseReceipt(expenseId,receipt.id);
   if(!imageTypes.has(blob.type))throw Error('이미지를 미리 볼 수 없습니다. 원본 파일을 내려받아 확인해 주세요.');
   return blob;
  },
  enabled:enabled&&isImage(receipt),staleTime:Infinity,gcTime:60000,retry:1,
 });
 const [source,setSource]=useState(null);
 useEffect(()=>{
  if(!query.data)return;
  const url=URL.createObjectURL(query.data);
  setSource({blob:query.data,url});
  return ()=>URL.revokeObjectURL(url);
 },[query.data]);
 return {...query,url:source&&source.blob===query.data?source.url:''};
}

export function ExpenseReceiptThumbnail({expenseId,count,onOpen}){
 const button=useRef(null),visible=useVisible(button);
 const detail=useAttachmentDetail(expenseId,visible&&count>0);
 const receipts=detail.data?.receipts||[],receipt=receipts.find(isImage)||receipts[0];
 const image=useAttachmentImage(expenseId,receipt,visible&&!detail.error);
 const [failedImage,setFailedImage]=useState(null);
 const failed=!!detail.error||!!image.error||!!image.data&&failedImage===image.data;
 const url=!failed&&image.url;
 const label=`지출 ${expenseId} 첨부파일 ${count}개 보기`;
 return <button ref={button} type="button" className="expense-receipt-thumbnail" onClick={onOpen} aria-label={label} title={failed?`${label} · 미리보기를 불러오지 못했습니다`:label}>
  <span className="expense-receipt-circle">{url?<img src={url} alt="" loading="lazy" onError={()=>setFailedImage(image.data)}/>:receipt?.mime==='application/pdf'?<span className="expense-receipt-pdf">PDF</span>:<Icon name={failed?'warn':'paperclip'} size={18}/>}</span>
  {count>1&&<span className="expense-receipt-count" aria-hidden="true">+{count-1}</span>}
 </button>;
}

function ReceiptChoice({expenseId,receipt,selected,onClick}){
 const image=useAttachmentImage(expenseId,receipt);
 const [failedImage,setFailedImage]=useState(null);
 const url=!image.error&&failedImage!==image.data&&image.url;
 return <button type="button" className="expense-inline-receipt-choice" aria-pressed={selected} aria-label={`${receipt.filename} 선택`} title={receipt.filename} onClick={onClick}>{url?<img src={url} alt="" onError={()=>setFailedImage(image.data)}/>:<span>{receipt.mime==='application/pdf'?'PDF':<Icon name="file" size={20}/>}</span>}</button>;
}

// The detail drawer already owns receipt metadata. Sharing the image query key
// with thumbnails and the full viewer avoids requesting the same file again.
export function ExpenseInlineAttachments({expenseId,receipts,onOpen}){
 const [selection,setSelection]=useState(null),[failedImage,setFailedImage]=useState(null);
 useEffect(()=>{setSelection(null);setFailedImage(null);},[expenseId]);
 const receipt=receipts.find(file=>file.id===selection)||receipts[0];
 const image=useAttachmentImage(expenseId,receipt);
 const failed=!!image.error||!!image.data&&failedImage===image.data;
 return <section className="expense-inline-attachments" aria-label="지출 영수증 미리보기">
  <div className="expense-inline-preview">{!receipt?<div className="expense-inline-empty"><Icon name="file" size={42}/><p>첨부파일이 없습니다.</p></div>:isImage(receipt)?failed?<BusinessError onRetry={()=>{setFailedImage(null);image.refetch();}}>이미지를 불러오지 못했습니다.</BusinessError>:image.url?<button type="button" className="expense-inline-image" aria-label={`${receipt.filename} 크게 보기`} onClick={()=>onOpen(receipt.id)}><img src={image.url} alt={receipt.filename} onError={()=>setFailedImage(image.data)}/></button>:<p role="status">영수증을 불러오는 중…</p>:<div className="expense-inline-empty"><Icon name="file" size={42}/><strong>{receipt.mime==='application/pdf'?'PDF 첨부파일':'첨부파일'}</strong><p>파일을 열어 다운로드할 수 있습니다.</p></div>}</div>
  {receipt&&<><div className="expense-inline-caption"><span title={receipt.filename}>{receipt.filename}</span><BusinessButton icon="eye" onClick={()=>onOpen(receipt.id)}>{isImage(receipt)?'크게 보기':'파일 보기'}</BusinessButton></div><div className="expense-inline-receipts" role="group" aria-label="영수증 선택">{receipts.map(file=><ReceiptChoice key={file.id} expenseId={expenseId} receipt={file} selected={receipt.id===file.id} onClick={()=>setSelection(file.id)}/>)}</div></>}
 </section>;
}

export function ExpenseAttachmentViewer({expenseId,initialReceiptId,onClose}){
 const detail=useAttachmentDetail(expenseId);
 const [selection,setSelection]=useState(initialReceiptId),[busy,setBusy]=useState(false),[error,setError]=useState(''),[failedImage,setFailedImage]=useState(null);
 const busyRef=useRef(false);
 useEffect(()=>{setSelection(initialReceiptId);setError('');},[expenseId,initialReceiptId]);
 const receipts=detail.data?.receipts||[],index=Math.max(0,receipts.findIndex(file=>file.id===selection)),receipt=receipts[index];
 const image=useAttachmentImage(expenseId,receipt,!detail.error);
 const native=typeof window!=='undefined'&&!!(window.GpsNative||window.FlutterAppOpenUrl);
 const change=next=>{setSelection(receipts[next]?.id);setError('');};
 async function download(asPdf=false){
  if(busyRef.current||!receipt)return;
  busyRef.current=true;setBusy(true);setError('');
  try{
   const blob=image.data||await api.downloadExpenseReceipt(expenseId,receipt.id);
   await downloadReceipt(blob,receipt.filename,asPdf);
  }catch(e){setError(e.message||'첨부파일을 내려받지 못했습니다. 다시 시도해 주세요.');}
  finally{busyRef.current=false;setBusy(false);}
 }
 const imageFailed=!!image.error||!!image.data&&failedImage===image.data;
 return <Modal open size="xl" title="첨부파일" subtitle={`지출 #${expenseId}`} onClose={busy?undefined:onClose}>
  <div className="expense-attachment-viewer">
   {detail.error?<BusinessError onRetry={detail.refetch}>첨부파일 목록을 불러오지 못했습니다.</BusinessError>:!detail.data?<p role="status">첨부파일을 불러오는 중…</p>:!receipt?<p>첨부된 파일이 없습니다.</p>:<>
    <div className="expense-attachment-heading"><strong title={receipt.filename}>{receipt.filename}</strong><span>{index+1} / {receipts.length}</span></div>
    {receipts.length>1&&<div className="expense-attachment-file-list" role="group" aria-label="첨부파일 선택">{receipts.map((file,i)=><button key={file.id} type="button" className="expense-attachment-file-option" aria-pressed={index===i} disabled={busy} onClick={()=>change(i)} title={file.filename}><Icon name={isImage(file)?'cam':'file'} size={16}/><span>{file.filename}</span><small>{Math.ceil(file.size_bytes/1024)} KB</small></button>)}</div>}
    <div className="expense-attachment-preview">
     {isImage(receipt)?imageFailed?<BusinessError onRetry={()=>{setFailedImage(null);image.refetch();}}>이미지를 미리 볼 수 없습니다. 다운로드하여 확인해 주세요.</BusinessError>:image.url?<img src={image.url} alt={receipt.filename} onError={()=>setFailedImage(image.data)}/>:<p role="status">이미지를 불러오는 중…</p>:<div className="expense-attachment-file"><Icon name="file" size={42}/><strong>{receipt.mime==='application/pdf'?'PDF 첨부파일':'첨부파일'}</strong><p>다운로드하여 내용을 확인할 수 있습니다.</p></div>}
    </div>
    <div className="expense-attachment-toolbar">
     {receipts.length>1&&<div className="expense-attachment-pages"><BusinessButton icon="chevron-left" aria-label="이전 첨부파일" disabled={busy||index===0} onClick={()=>change(index-1)}/><BusinessButton icon="chevron-right" aria-label="다음 첨부파일" disabled={busy||index===receipts.length-1} onClick={()=>change(index+1)}/></div>}
     <div className="expense-attachment-downloads">{isImage(receipt)&&!native&&<BusinessButton icon="download" disabled={busy} onClick={()=>download()}>원본 다운로드</BusinessButton>}<BusinessButton icon="download" disabled={busy} onClick={()=>download(isImage(receipt))}>{busy?'다운로드 중…':'PDF 다운로드'}</BusinessButton></div>
    </div>
    {error&&<p className="expense-attachment-error" role="alert">{error}</p>}
   </>}
  </div>
 </Modal>;
}
