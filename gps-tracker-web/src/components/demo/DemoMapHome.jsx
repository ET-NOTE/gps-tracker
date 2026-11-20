import { useEffect, useState } from 'react';
import Icon from '../Icon';
import DemoRouteMap from './DemoRouteMap';
import { demoVehicles, demoPointTime } from './demoVehicles';

const serviceTitles = {corporate:'법인운행',rentcar:'렌트카',cargo:'화물배차'};
function RouteHistory({ vehicle, openBusiness }) {
  const last = vehicle.points.length - 1;
  const [index, select] = useState(last);
  const [playing, play] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (index >= last) { play(false); return; }
    const timer = setTimeout(() => select(index + 1), 750);
    return () => clearTimeout(timer);
  }, [index, playing, last]);
  function togglePlay() {
    if (index === last) select(0);
    play(v=>!v);
  }
  return <section className="demo-history" aria-label="선택 차량의 운행 기록">
    <div className="demo-history-title"><div><span>{serviceTitles[vehicle.service]}</span><h2>{vehicle.name}</h2></div>
      <button type="button" className="demo-link" onClick={()=>openBusiness(vehicle.service)}>{vehicle.service === 'corporate' ? '운행기록부' : vehicle.service === 'cargo' ? '통합 배차' : '예약 목록'}<Icon name="chevron-right" size={15}/></button>
    </div>
    <DemoRouteMap vehicle={vehicle} position={index}/>
    <div className="demo-track-panel">
      <div className="demo-trip-line"><span>{vehicle.from}</span><Icon name="chevron-right" size={16}/><strong>{vehicle.to}</strong><b>{vehicle.km.toLocaleString('ko-KR')} km</b></div>
      <div className="demo-playback">
        <button type="button" onClick={togglePlay} aria-pressed={playing}>{playing ? '일시정지' : '경로 재생'}</button>
        <input aria-label="운행 기록 시점" type="range" min={0} max={last} value={index}
          aria-valuetext={demoPointTime(vehicle,index)} onChange={e=>{play(false);select(Number(e.target.value));}}/>
        <output>{demoPointTime(vehicle,index)}</output>
      </div>
      <div className="demo-track-times"><span>{vehicle.start} 출발</span><span>{vehicle.end} 도착</span></div>
    </div>
  </section>;
}

export default function DemoMapHome({ device, onDevice, openBusiness }) {
  const selected=demoVehicles.find(v=>v.id===device) || demoVehicles[0];
  return <div className="demo-map-layout">
    <section className="demo-fleet-list" aria-label="예시 차량 목록">
      <div className="demo-list-title"><h2>차량 목록</h2><span>{demoVehicles.length}대</span></div>
      <div className="demo-car-options">{demoVehicles.map(v=>
        <button type="button" key={v.id} className="demo-car" aria-pressed={v===selected} onClick={()=>onDevice(v.id)}>
          <span className="demo-car-icon"><Icon name="car" size={20}/></span>
          <span><strong>{v.name}</strong><small>{v.model} · {v.plate}</small></span>
          <Icon name="chevron-right" size={15}/>
        </button>)}</div>
      <label className="demo-mobile-picker">차량 선택<select value={selected.id} onChange={e=>onDevice(e.target.value)}>
        {demoVehicles.map(v=><option value={v.id} key={v.id}>{v.name} · {v.plate}</option>)}
      </select></label>
    </section>
    <RouteHistory key={selected.id} vehicle={selected} openBusiness={openBusiness}/>
  </div>;
}
