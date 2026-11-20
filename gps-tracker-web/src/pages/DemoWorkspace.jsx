import { useEffect } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import Icon from '../components/Icon';
import DemoMapHome from '../components/demo/DemoMapHome';
import DemoCorporate from '../components/demo/DemoCorporate';
import DemoOperations from '../components/demo/DemoOperations';
import { useDemoTheme } from '../components/demo/useDemoTheme';
import { internalDestination } from '../lib/platformNavigation';
import '../components/demo/demoWorkspace.css';

const areas = [
  {id:'map',path:'/demo',label:'지도 홈',icon:'map'},
  {id:'corporate',path:'/demo/corporate',label:'법인운행',icon:'office'},
  {id:'rentcar',path:'/demo/rentcar',label:'렌트카',icon:'car'},
  {id:'cargo',path:'/demo/cargo',label:'화물배차',icon:'route'},
];
const pages = {corporate:['vehicles','trips','expenses'],rentcar:['reservations','fleet'],cargo:['dispatch','orders']};

export default function DemoWorkspace() {
  useDemoTheme();
  const location=useLocation(), navigate=useNavigate();
  const area=areas.find(item=>item.path===location.pathname.replace(/\/+$/,''));
  const params=new URLSearchParams(location.search);
  const loginNext=internalDestination(location.state?.loginNext);
  const state=loginNext ? {loginNext} : null;
  const exitPath=loginNext ? '/login?next='+encodeURIComponent(loginNext) : '/login';
  const choices=pages[area?.id] || [];
  const page=choices.includes(params.get('page')) ? params.get('page') : choices[0];
  useEffect(()=>{
    const before=document.title;
    document.title=(area?.label || '지도 홈')+' · 시리얼링크 데모';
    return ()=>{document.title=before;};
  },[area]);
  if (!area) return <Navigate to="/demo" state={state} replace/>;
  const change=(to, replace=false)=>navigate(to,{state,replace});
  const showMap=id=>change('/demo?device='+encodeURIComponent(id),area.id==='map');
  const showBusiness=id=>change(id==='corporate'?'/demo/corporate?page=trips':'/demo/'+id);
  const changePage=id=>{if(choices.includes(id))change(area.path+'?page='+encodeURIComponent(id));};
  return <div className="demo-shell">
    <header className="demo-top">
      <Link className="demo-wordmark" to="/demo" state={state}><span><Icon name="car" size={20}/></span>시리얼링크</Link>
      <span className="demo-mode">데모 체험</span>
      <div className="demo-top-actions"><span>예시 데이터 · 조회 전용</span><Link to={exitPath} replace className="demo-exit">체험 종료<Icon name="chevron-right" size={14}/></Link></div>
    </header>
    <nav className="demo-rail" aria-label="데모 서비스">
      {areas.map(item=><Link to={item.path} key={item.id} state={state} aria-current={item.id===area.id?'page':undefined}>
        <Icon name={item.icon} size={21}/><span>{item.label}</span>
      </Link>)}
    </nav>
    <main className="demo-main" key={area.id} aria-label={area.label}>
      <div className="demo-content">
        <div className="demo-heading"><h1>{area.label}</h1><time dateTime="2026-11-20T15:00:00+09:00">2026. 11. 20. 15:00 기준</time></div>
        {area.id === 'map' ? <DemoMapHome device={params.get('device')} onDevice={showMap} openBusiness={showBusiness}/>
          : area.id === 'corporate' ? <DemoCorporate page={page} onPage={changePage} onMap={showMap}/>
          : <DemoOperations key={area.id} service={area.id} page={page} onPage={changePage} onMap={showMap}/>}
      </div>
    </main>
  </div>;
}
