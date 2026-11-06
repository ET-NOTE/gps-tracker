import {useEffect,useRef,useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../api';
import {saveBlob} from '../lib/fileDownload';
const kinds={document:'문서 페이지',photo:'사진',receipt:'영수증'};
const date=v=>new Date(v).toLocaleString('ko-KR');
const valid=d=>d.available&&!d.revoked_at&&new Date(d.expires_at)>new Date();
export function selectedPixels(rgba,width,height,regions){
 if(width<1||height<1||width>2048||height>2048||width*height>1000000||rgba.length!==width*height*4||!regions.length||regions.length>30)throw Error('이미지 크기 또는 영역을 확인해 주세요.');
 const out=new Uint8Array(width*height*3);
 for(const r of regions){if(![r.x,r.y,r.width,r.height].every(Number.isInteger)||r.x<0||r.y<0||r.width<1||r.height<1||r.x+r.width>width||r.y+r.height>height)throw Error('이미지 안의 영역을 지정해 주세요.');
  for(let y=r.y;y<r.y+r.height;y++)for(let x=r.x;x<r.x+r.width;x++){const i=y*width+x;for(let c=0;c<3;c++)out[i*3+c]=Math.round(rgba[i*4+c]*(rgba[i*4+3]/255)+255*(1-rgba[i*4+3]/255));}}
 return out;
}
export function fitSize(width,height){
 const inside=(w,h)=>w<=2048&&h<=2048&&w*h<=1000000;
 if(!(width>=1&&height>=1)||inside(width,height))return[width,height];
 const long=Math.max(width,height),short=Math.min(width,height),other=l=>Math.max(1,Math.floor(l*short/long));
 let lo=1,hi=Math.min(long,2048);
 while(lo<hi){const mid=lo+Math.ceil((hi-lo)/2);if(inside(mid,other(mid)))lo=mid;else hi=mid-1;}
 return width>=height?[lo,other(lo)]:[other(lo),lo];
}
const turns={2:'좌우 반전',3:'180° 회전',4:'상하 반전',5:'대각 반전',6:'시계 방향 90° 회전',7:'대각 반전',8:'반시계 방향 90° 회전'};
export function sourceNote(n){
 if(!n)return'';
 const parts=[];
 if(n.reduced)parts.push(`원본 ${n.source_width} × ${n.source_height}px 축소`);
 if(turns[n.orientation])parts.push(`촬영 방향 보정(${turns[n.orientation]})`);
 return parts.join(' · ');
}
function encode(bytes){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export function AdminImages({request,refresh}){
 const enabled=['in_review','needs_information'].includes(request.status)&&!!request.due_at;
 const q=useQuery({queryKey:['admin-privacy-images',request.id,request.revision],queryFn:()=>api.adminPrivacyImage(request.id),retry:false});
 const companies=useQuery({queryKey:['privacy-image-companies',request.id,request.revision],queryFn:()=>api.adminCompanyReviews(request.id),enabled,retry:false});
 const [scope,setScope]=useState(''),[kind,setKind]=useState('document'),[reference,setReference]=useState(''),[notice,setNotice]=useState(''),[source,setSource]=useState(null),[regions,setRegions]=useState([]),[rect,setRect]=useState({x:0,y:0,width:1,height:1}),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[sourceConfirmed,setSourceConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [receiptPage,setReceiptPage]=useState(0);
 const canvas=useRef(null),input=useRef(null),start=useRef(null),generation=useRef(0);
 const currentCompany=companies.data?.items?.find(x=>String(x.id)===scope);
 const validCompany=currentCompany&&currentCompany.identity==='confirmed'&&currentCompany.staff_id&&!['excluded','restricted'].includes(currentCompany.status);
 const receiptScope=validCompany&&['expenses','files'].includes(currentCompany.category);
 const receipts=useQuery({queryKey:['privacy-receipt-sources',request.id,scope,currentCompany?.revision,receiptPage],queryFn:()=>api.privacyReceiptSources(request.id,Number(scope),currentCompany.revision,receiptPage),enabled:enabled&&!!receiptScope,retry:false});
 function invalidate(){setPreview(null);setConfirmed(false);setSourceConfirmed(false);setError('');}
 function clear(){generation.current++;setSource(null);setRegions([]);invalidate();if(input.current)input.current.value='';}
 useEffect(()=>{window.addEventListener('pagehide',clear);return()=>{generation.current++;window.removeEventListener('pagehide',clear);};},[]);
 useEffect(()=>{clear();setScope('');setReference('');setNotice('');},[request.id]);
 useEffect(()=>{generation.current++;invalidate();},[request.revision]);
 useEffect(()=>{clear();setReceiptPage(0);},[scope,currentCompany?.revision]);
 useEffect(()=>{if(!source||!canvas.current)return;const c=canvas.current;c.width=source.width;c.height=source.height;const ctx=c.getContext('2d');ctx.putImageData(source.image,0,0);ctx.lineWidth=Math.max(2,source.width/250);ctx.strokeStyle='#1465f4';for(const r of regions)ctx.strokeRect(r.x,r.y,r.width,r.height);},[source,regions]);
 async function load(file,binding=null){clear();if(!file)return;const gen=generation.current;setBusy(true);let url;
  try{if(!['image/png','image/jpeg'].includes(file.type)||file.size>6*1024*1024)throw Error('PNG 또는 JPG 한 페이지(최대 6MB)를 선택해 주세요. PDF는 필요한 페이지를 이미지로 준비하세요.');
   const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('');
   if(binding&&hash!==binding.display_sha256)throw Error('원본이 변경됐습니다. 다시 불러오세요.');
   url=URL.createObjectURL(file);const img=new Image();img.src=url;await img.decode();if(gen!==generation.current)return;
   const {naturalWidth:sw,naturalHeight:sh}=img;if(sw<1||sh<1||sw>16384||sh>16384||sw*sh>64000000)throw Error('한 변 16,384px·총 6,400만 화소 이하의 이미지를 선택해 주세요.');
   const [width,height]=binding?[sw,sh]:fitSize(sw,sh);if(width>2048||height>2048||width*height>1000000)throw Error('서버가 보낸 이미지 크기가 한도를 넘습니다. 다시 불러오세요.');
   const reduced=width!==sw||height!==sh;
   const c=document.createElement('canvas');c.width=width;c.height=height;const ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.imageSmoothingEnabled=reduced;ctx.imageSmoothingQuality='high';ctx.drawImage(img,0,0,width,height);setSource({width,height,image:ctx.getImageData(0,0,width,height),hash:binding?.sha256||hash,receipt:binding?.receipt||null,note:sourceNote(binding?binding.normalization:{reduced,source_width:sw,source_height:sh})});setRect({x:0,y:0,width:Math.min(100,width),height:Math.min(100,height)});
  }catch(e){setError(e.message);}finally{if(url)URL.revokeObjectURL(url);setBusy(false);}}
 async function openReceipt(id){clear();const gen=generation.current;setBusy(true);try{const b=await api.readPrivacyReceipt(request.id,Number(scope),id,currentCompany.revision);if(gen!==generation.current)return;setKind('receipt');setReference(`지출 #${b.expense_id} / 영수증 #${id}`);await load(new File([Uint8Array.from(atob(b.data_base64),c=>c.charCodeAt(0))],`receipt-${id}`,{type:b.mime}),b);}catch(e){if(gen===generation.current)setError(e.message);}finally{setBusy(false);}}
 function add(r=rect){try{selectedPixels(source.image.data,source.width,source.height,[...regions,r]);setRegions([...regions,r]);invalidate();}catch(e){setError(e.message);}}
 function point(e){const b=e.currentTarget.getBoundingClientRect();return{x:Math.max(0,Math.min(source.width,Math.round((e.clientX-b.left)*source.width/b.width))),y:Math.max(0,Math.min(source.height,Math.round((e.clientY-b.top)*source.height/b.height)))};}
 function selection(){return{receipt:source.receipt,company_review_id:scope==='personal'?null:Number(scope),company_revision:scope==='personal'?null:currentCompany?.revision,category:kind,source_reference:reference,source_sha256:source.hash,width:source.width,height:source.height,regions,notice,rgb_base64:encode(selectedPixels(source.image.data,source.width,source.height,regions))};}
 async function prepare(){const gen=generation.current;setBusy(true);invalidate();try{const p=await api.previewPrivacyImage(request.id,selection());if(gen===generation.current)setPreview(p);}catch(e){if(gen===generation.current)setError(e.message);}finally{setBusy(false);}}
 async function issue(){setBusy(true);setError('');try{await api.issuePrivacyImage(request.id,{...selection(),revision:request.revision,preview_sha256:preview.preview_sha256,confirmed,source_confirmed:sourceConfirmed});clear();await refresh();await q.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 async function revoke(id){setBusy(true);setError('');try{await api.revokePrivacyImage(id);await q.refetch();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="rights-impact"><h3>사진·영수증·문서 일부 제공</h3><p>본인 자료로 확인한 페이지를 준비하고 공개할 영역만 지정하세요. 나머지는 검게 제거합니다. 회사의 처리 증빙이 자동으로 전달되지는 않습니다.</p>
 {enabled&&<fieldset disabled={busy}>
 <label>확인한 자료 범위<select value={scope} onChange={e=>{setScope(e.target.value);invalidate();}}><option value="">범위 선택</option><option value="personal">별도 확인한 개인 자료</option>{companies.data?.items?.filter(c=>c.identity==='confirmed'&&c.staff_id&&!['excluded','restricted'].includes(c.status)).map(c=><option key={c.id} value={c.id}>회사 검토 #{c.id} · {({expenses:'지출',files:'첨부 자료',staff:'사용자',trips:'운행',reservations:'예약',snapshots:'이력'})[c.category]||c.category} · 명단 {c.staff_id}</option>)}</select></label>
 {validCompany&&<p>확인 범위 {date(currentCompany.from_at)} ~ {date(currentCompany.until_at)} · 이 범위의 본인 자료만 준비하세요.</p>}
 <div className="rights-date-row"><label>자료 종류<select disabled={!!source?.receipt} value={kind} onChange={e=>{setKind(e.target.value);invalidate();}}>{Object.entries(kinds).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label><label>원본 내부 참조번호·페이지<input readOnly={!!source?.receipt} maxLength={160} value={reference} onChange={e=>{setReference(e.target.value);invalidate();}} placeholder="예: 문서 123 / 2페이지"/></label></div>
 {receiptScope&&<div className="rights-request"><h4>회사에 저장된 영수증</h4><p>확인된 사용자의 지출일 기준으로 조회합니다(시작일 포함·종료일 제외, 한국 날짜). PNG/JPG를 열고 공개할 영역을 지정하세요. 100만 화소·한 변 2048px를 넘는 사진은 서버가 축소하고 촬영 방향을 바로 세워 보여 주며, 제공본도 같은 축소본에서 만듭니다.</p>{receipts.error&&<p role="alert">영수증을 불러오지 못했습니다. <button type="button" onClick={()=>receipts.refetch()}>다시 시도</button></p>}{receipts.isLoading&&<p>불러오는 중…</p>}{receipts.data?.items?.length===0&&<p>이 범위에서 불러올 이미지 영수증이 없습니다.</p>}{receipts.data?.items?.map(r=><div className="rights-heading" key={r.id}><span>{r.spent_on} · {r.category} · {Number(r.amount_krw).toLocaleString()}원 · 영수증 #{r.id}</span><button type="button" onClick={()=>openReceipt(r.id)}>원본 확인·불러오기</button></div>)}{receiptPage>0&&<button type="button" onClick={()=>setReceiptPage(0)}>처음 목록</button>}{receipts.data?.next&&<button type="button" onClick={()=>setReceiptPage(receipts.data.next)}>다음 영수증</button>}</div>}
 <label>직접 준비한 페이지 (PNG·JPG)<input ref={input} type="file" accept="image/png,image/jpeg" onChange={e=>load(e.target.files?.[0])}/></label><p>최대 6MB. 100만 화소·한 변 2048px를 넘으면 이 브라우저에서 축소합니다. PDF는 페이지별 이미지로 준비하세요. 원본과 본인 귀속은 담당자가 대조합니다.</p>
 {source&&<><p>{source.receipt?'서버 원본 연결 · 변경 시 제공 중단':'수동 준비 원본'} · {source.width} × {source.height}px{source.note?` · ${source.note}`:''} · 공개 영역 {regions.length}/30개</p><canvas ref={canvas} className="rights-image-canvas" aria-label="공개할 영역을 지정하는 원본 이미지" onPointerDown={e=>{if(busy)return;start.current=point(e);e.currentTarget.setPointerCapture(e.pointerId);}} onPointerCancel={()=>{start.current=null;}} onPointerUp={e=>{if(!start.current)return;const end=point(e),a=start.current;start.current=null;add({x:Math.min(a.x,end.x),y:Math.min(a.y,end.y),width:Math.abs(a.x-end.x),height:Math.abs(a.y-end.y)});}}/>
 <p>공개할 부분을 드래그하거나 아래 좌표로 지정하세요. 기본 상태에서는 아무 부분도 제공하지 않습니다.</p>
 <div className="rights-image-coordinates">{[['x','왼쪽'],['y','위쪽'],['width','너비'],['height','높이']].map(([key,label])=><label key={key}>{label} (px)<input type="number" min={key==='x'||key==='y'?0:1} step="1" value={rect[key]} onChange={e=>setRect({...rect,[key]:Number(e.target.value)})}/></label>)}</div><button type="button" disabled={regions.length>=30} onClick={()=>add()}>이 영역 공개</button> <button type="button" onClick={clear}>이미지 닫기</button>
 {regions.map((r,i)=><div key={i} className="rights-heading"><span>영역 {i+1} · {r.x}, {r.y} / {r.width} × {r.height}px</span><button type="button" onClick={()=>{setRegions(regions.filter((_,n)=>n!==i));invalidate();}}>제외</button></div>)}
 <label>요청자에게 안내할 제공 범위·제외 사유<textarea rows={3} maxLength={1000} value={notice} onChange={e=>{setNotice(e.target.value);invalidate();}}/></label>
 <button type="button" disabled={!regions.length||!reference.trim()||!notice.trim()||!(scope==='personal'||validCompany)} onClick={prepare}>이미지 제공본 미리보기</button>
 {preview&&<div className="rights-request"><h4>실제 제공할 이미지</h4><img className="rights-image-preview" src={`data:image/png;base64,${preview.png_base64}`} alt="선택한 영역만 남기고 나머지는 검게 제거한 제공본"/><p className="rights-text">{preview.notice}</p>
 <label className="rights-confirm"><input type="checkbox" checked={sourceConfirmed} onChange={e=>setSourceConfirmed(e.target.checked)}/> 원본·본인 귀속·회사 및 기간 범위를 직접 대조했습니다.</label>
 <label className="rights-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> 위 이미지와 안내에서 타인 정보 제외와 제공 범위를 확인했습니다.</label>
 <button type="button" disabled={!confirmed||!sourceConfirmed} onClick={issue}>이미지 24시간 제공</button></div>}
 </>}
 </fieldset>}
 {(error||q.error||companies.error)&&<p className="rights-error" role="alert">{error||q.error?.message||companies.error?.message}</p>}
 {!enabled&&<p>검토 상태와 처리 기한을 지정하면 준비할 수 있습니다.</p>}
 {q.data?.items?.map(d=><div className="rights-request" key={d.id}><p>#{d.id} · {kinds[d.category]} · {valid(d)?'다운로드 가능':'제공 종료'} · {date(d.expires_at)}</p><p>{d.source_reference}{d.receipt_id?' · 서버 원본 연결':''}{sourceNote(d.source_normalization)?` · ${sourceNote(d.source_normalization)}`:''} · {d.company_review_id?`회사 검토 #${d.company_review_id}`:'개인 자료'}</p><p className="rights-text">{d.notice}</p>{!d.revoked_at&&<button type="button" disabled={busy} onClick={()=>revoke(d.id)}>제공 회수·임시 파일 제거</button>}</div>)}
 {!!q.data?.events?.length&&<details><summary>이미지 검토·제공 이력</summary>{q.data.events.map(e=><p key={e.id}>{date(e.created_at)} · {({preview:'미리보기',issued:'발급',revoked:'회수',download_prepared:'다운로드 응답 생성',payload_removed:'임시 파일 제거'})[e.action]}</p>)}</details>}
 <p>일부 제공이며 요청 전체 완료가 아닙니다. 임시 파일은 만료 후 제거됩니다. 원본·검토 이력·백업은 별도 처리하며 이미 내려받은 사본은 회수할 수 없습니다.</p>
 </section>;
}
export function PersonalImages({request}){
 const q=useQuery({queryKey:['personal-privacy-images',request.id,request.revision],queryFn:()=>api.personalPrivacyImage(request.id),retry:false});const [password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 useEffect(()=>{const clear=()=>{setPassword('');setMessage('');};window.addEventListener('pagehide',clear);return()=>window.removeEventListener('pagehide',clear);},[]);
 async function download(id){setBusy(true);setError('');setMessage('');try{await saveBlob(await api.downloadPrivacyImage(id,password),`reviewed-image-${id}.png`);setMessage('파일 저장을 요청했습니다. 다운로드 목록을 확인해 주세요.');}catch(e){setError(e.message);}finally{setPassword('');setBusy(false);}}
 useEffect(()=>{setPassword('');setMessage('');setError('');},[request.id]);
 const allowed=!['cancelled','rejected'].includes(request.status);
 return <section className="rights-delivery">{q.error&&<p role="alert">제공 이미지를 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>}{!!q.data?.items?.length&&<><h4>검토한 이미지 · 일부 제공</h4><p>검게 표시된 부분은 제외한 영역입니다. 자료별 안내를 함께 확인하세요.</p>{allowed&&q.data.items.some(valid)&&<label>다운로드 확인용 현재 비밀번호<input type="password" autoComplete="current-password" disabled={busy} value={password} onChange={e=>setPassword(e.target.value)}/></label>}{q.data.items.map(d=><div className="rights-request" key={d.id}><p>{kinds[d.category]} · {valid(d)?'다운로드 가능':'제공 종료'} · 만료 {date(d.expires_at)}</p><p className="rights-text">{d.notice}</p>{allowed&&valid(d)&&<button type="button" disabled={busy||!password} onClick={()=>download(d.id)}>검토한 이미지 내려받기</button>}</div>)}</>}{error&&<p role="alert" className="rights-error">{error}</p>}{message&&<p role="status">{message}</p>}</section>;
}
