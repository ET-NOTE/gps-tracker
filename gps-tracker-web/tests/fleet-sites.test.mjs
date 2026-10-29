import test from 'node:test';
import assert from 'node:assert/strict';
import {searchSiteAddress,usableGeometry,visitDuration,visitStatus,siteVehicleLabel} from '../src/lib/fleetSites.js';

test('visit filter distinguishes unnamed vehicles without replacing vehicle identity',()=>{
 const car={id:12,name:'차량 정보 미등록',bindings:[{is_primary:true,terminal_name:'단말-520211'}]};
 assert.equal(siteVehicleLabel(car),'차량 정보 미등록 · 단말: 단말-520211');
 assert.notEqual(siteVehicleLabel(car),siteVehicleLabel({...car,id:13,bindings:[]}));
 assert.equal(siteVehicleLabel({...car,name:'업무 차량',license_plate:'12가3456'}),'업무 차량 · 12가3456');
 assert.equal(siteVehicleLabel({...car,name:'12가3456',license_plate:'12가3456'}),'12가3456');
});

test('visit copy separates observed presence, gaps and configuration changes',()=>{
 assert.notEqual(visitStatus.inside,visitStatus.stale);
 assert.match(visitStatus.configuration,/설정/);
 assert.match(visitStatus.gap,/공백/);
 assert.equal(visitDuration(null),'1분 미만');
 assert.equal(visitDuration(3660),'1시간 1분');
 assert.equal(usableGeometry({type:'circle',lat:null,lng:null,radius_m:200}),false);
 assert.equal(usableGeometry({type:'polygon',points:[[37,127],[37.01,127]]}),false);
});
test('address search resolves road address and coordinates, falls back only for zero results',async()=>{
 let mode='address',keywords=0;
 global.window={kakao:{maps:{Map:class{},services:{Status:{OK:'ok',ZERO_RESULT:'none'},Geocoder:class{addressSearch(q,cb){cb(mode==='address'?[{x:'126.978',y:'37.5665',road_address:{building_name:'시청',address_name:'세종대로 110'}}]:[],mode==='address'?'ok':mode==='error'?'failed':'none');}},Places:class{keywordSearch(q,cb){keywords++;cb(mode==='none'?[]:[{place_name:'본사',road_address_name:'주소',x:'127',y:'37'}],mode==='none'?'none':'ok');}}}}}};
 const first=await searchSiteAddress('시청');assert.deepEqual(first,[{name:'시청',address:'세종대로 110',lat:37.5665,lng:126.978}]);assert.equal(keywords,0);
 mode='keyword';assert.equal((await searchSiteAddress('본사'))[0].name,'본사');assert.equal(keywords,1);
 mode='none';assert.deepEqual(await searchSiteAddress('없는 주소'),[]);
 mode='error';await assert.rejects(searchSiteAddress('오류'),/주소 검색에 실패/);assert.equal(keywords,2);
 delete global.window;
});
