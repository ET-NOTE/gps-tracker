import { useEffect } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import DemoMapHome from '../components/demo/DemoMapHome';
import ReferenceFrame from '../components/demo/ReferenceFrame';
import { demoHref, demoTarget } from '../components/demo/referenceNavigation';
import { endSampleSession } from '../components/demo/referenceSession';
import { useDemoTheme } from '../components/demo/useDemoTheme';
import { internalDestination } from '../lib/platformNavigation';
import '../components/demo/demoWorkspace.css';
import '../components/demo/reference.css';

const paths = ['/demo', '/demo/corporate', '/demo/rentcar', '/demo/cargo'];
const mapLinks = {corporate:'/demo/corporate?view=trips', rentcar:'/demo/rentcar?view=rent-reservations', cargo:'/demo/cargo?view=cargo-dispatch'};

export default function DemoWorkspace() {
  useDemoTheme();
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname.replace(/\/+$/, '');
  const loginNext = internalDestination(location.state?.loginNext);
  const state = loginNext ? {loginNext} : null;
  const device = path === '/demo' && new URLSearchParams(location.search).get('device');
  const target = demoTarget(path, location.search);
  useEffect(() => {
    const previous = document.title;
    document.title = '시리얼링크 · 데모 체험';
    return () => { document.title = previous; };
  }, []);
  if (!paths.includes(path)) return <Navigate to="/demo" state={state} replace/>;
  function change(url, replace = false) { navigate(url, {state, replace}); }
  function exit() {
    endSampleSession();
    change(loginNext ? '/login?next=' + encodeURIComponent(loginNext) : '/login', true);
  }
  function openDevice(id) { change('/demo?device=' + encodeURIComponent(id), Boolean(device)); }
  if (!device) return <ReferenceFrame target={target} onRoute={next => change(demoHref(next))} onExit={exit} onMap={() => openDevice('seoul-01')}/>;
  return <div className="demo-shell fleet-demo-history">
    <header><button onClick={() => change('/demo')}>‹ 지도 홈</button><h1>차량 경로 재생</h1><button onClick={exit}>체험 종료</button></header>
    <main className="demo-main"><div className="demo-content"><DemoMapHome device={device} onDevice={openDevice} openBusiness={service => change(mapLinks[service])}/></div></main>
  </div>;
}
