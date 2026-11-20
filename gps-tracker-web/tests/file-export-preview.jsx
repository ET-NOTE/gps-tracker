// Only synthetic report data; no API/session or real vehicle access.
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../src/index.css';
import {initTheme} from '../src/theme';
import ExportButtons from '../src/components/business/ExportButtons';
import {tripReport} from '../src/lib/businessExport';
initTheme();
const report=tripReport([{started_at:'2026-10-20T00:00:00Z',ended_at:'2026-10-20T01:00:00Z',duration_min:60,distance_m:4200,annotation:{purpose:'business',driver_name:'가상 운전자',note:'쉼표, 따옴표 "예시"'}}],{device:{display_name:'가상 차량'},from:'2026-10-20',to:'2026-10-20'});
function Preview(){const [mode,setMode]=useState('browser'),[payload,setPayload]=useState('');
 const select=value=>{setMode(value);if(value==='browser')delete window.GpsFiles;else window.GpsFiles={version:1,exportReport:async request=>{setPayload(JSON.stringify({filename:request.filename,mime:request.mime,bytes:atob(request.base64).length}));return{ok:true,status:value};}};};
 return <main style={{padding:20,maxWidth:650,margin:'auto'}}><h1>보고서 내보내기</h1><p>모의 데이터 · 계정과 장치에 접근하지 않습니다.</p><label>동작 검증 <select value={mode} onChange={e=>select(e.target.value)}><option value="browser">브라우저 다운로드</option><option value="saved">앱 저장 완료</option><option value="share_opened">앱 공유 화면 열림</option><option value="cancelled">앱 사용자 취소</option></select></label><ExportButtons report={report}/><output>{payload}</output></main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
