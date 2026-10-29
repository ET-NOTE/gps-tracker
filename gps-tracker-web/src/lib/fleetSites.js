import {loadKakaoMaps} from './kakaoSdk.js';
export const visitStatus={inside:'구역 내 확인',stale:'이탈 미확인 · 수신 공백',exit:'이탈 확인',gap:'수신 공백으로 구간 종료',binding_end:'단말기 연결 종료',configuration:'구역 설정 변경'};
export function visitDuration(seconds){const n=Math.max(0,Number(seconds)||0);return n<60?'1분 미만':n<3600?`${Math.floor(n/60)}분`:`${Math.floor(n/3600)}시간 ${Math.floor(n%3600/60)}분`;}
export function siteShape(g){return g?.type==='circle'?`반경 ${g.radius_m>=1000?`${g.radius_m/1000}km`:`${g.radius_m}m`}`:`영역 · ${g?.points?.length||0}개 꼭짓점`;}
export function usableGeometry(g){return g?.type==='circle'?Number.isFinite(g.lat)&&Number.isFinite(g.lng)&&g.radius_m>=20&&g.radius_m<=50000:g?.type==='polygon'&&g.points.length>=3&&g.points.length<=32;}
export async function searchSiteAddress(query){
 await loadKakaoMaps();const sdk=window.kakao.maps.services;
 return new Promise((resolve,reject)=>{
  let done=false;const timer=setTimeout(()=>finish(null,new Error('주소 검색이 지연됩니다. 다시 시도해 주세요.')),10000);
  function finish(value,error){if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value);}
  new sdk.Geocoder().addressSearch(query,(rows,status)=>{
   if(done)return;
   if(status===sdk.Status.OK&&rows.length){finish(rows.slice(0,10).map(r=>({name:r.road_address?.building_name||'',address:r.road_address?.address_name||r.address?.address_name||r.address_name,lat:Number(r.y),lng:Number(r.x)})));return;}
   if(status!==sdk.Status.ZERO_RESULT){finish(null,new Error('주소 검색에 실패했습니다. 연결 상태를 확인해 주세요.'));return;}
   new sdk.Places().keywordSearch(query,(items,status)=>{
    if(status===sdk.Status.OK)finish(items.slice(0,10).map(r=>({name:r.place_name,address:r.road_address_name||r.address_name,lat:Number(r.y),lng:Number(r.x)})));
    else if(status===sdk.Status.ZERO_RESULT)finish([]);else finish(null,new Error('장소 검색에 실패했습니다. 다시 시도해 주세요.'));
   });
  });
 });
}
