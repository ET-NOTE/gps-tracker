// No API calls, account session, map SDK or live device writes.
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import '../src/index.css';
import SimRegistrationHelp from '../src/components/SimRegistrationHelp';
import SummaryChips from '../src/components/fleet/SummaryChips';
import {useDeviceDeepLink} from '../src/hooks/useDeviceDeepLink';
import {initTheme} from '../src/theme';
initTheme();
function Preview() {
 const [search,setSearch]=useState(''),[selected,setSelected]=useState(101),[filter,setFilter]=useState('all');
 const now=Date.now();
 const devices=[{id:101,display_name:'차량 A',last_seen_at:new Date(now-86400000).toISOString(),last_event_kind:'wake'},
  {id:102,display_name:'차량 B',last_seen_at:new Date(now).toISOString(),last_fix_at:new Date(now).toISOString()}];
 const link=useDeviceDeepLink({search,devices,loaded:true,ready:true,onSelect:setSelected,onConsume:setSearch});
 return <main style={{padding:16,maxWidth:500,margin:'auto',fontSize:14}}>
  <h1 style={{fontSize:20}}>단말기 등록</h1>
  <section style={{border:'1px solid var(--border)',padding:16,borderRadius:12,background:'var(--surface)'}}>
   <SimRegistrationHelp inputId="preview-sim"/><input id="preview-sim" placeholder="SIM 끝 8자리 (1NCE 화면 기준)" style={{width:'100%',boxSizing:'border-box',padding:12}}/>
   <label style={{display:'block',marginTop:12}}>단말기 이름<input placeholder="예: 1호차" style={{display:'block',width:'100%',boxSizing:'border-box',padding:12}}/></label>
   <button style={{marginTop:12,padding:12,width:'100%'}}>내 계정에 연결</button>
  </section>
  <h2 style={{fontSize:16}}>통신 상태</h2><SummaryChips devices={devices} filter={filter} onChange={setFilter}/>
  <h2 style={{fontSize:16}}>알림 대상</h2><p role="status">선택: {selected==null?'전체':devices.find(d=>d.id===selected)?.display_name}</p>
  <button onClick={()=>setSearch('?device=102')}>차량 B 알림 열기</button> <button onClick={()=>setSearch('?device=999')}>해제된 단말기 알림</button>
  {link.notice&&<div role="alert">{link.notice}<button onClick={link.dismiss}>닫기</button></div>}
 </main>;
}
createRoot(document.getElementById('root')).render(<Preview/>);
