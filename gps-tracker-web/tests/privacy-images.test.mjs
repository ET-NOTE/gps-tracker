import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import * as React from 'react';import * as jsx from 'react/jsx-runtime';import {create,act} from 'react-test-renderer';import {transform} from 'esbuild';
async function components(api={},queries={}){
 const context=vm.createContext({console,window:{addEventListener(){},removeEventListener(){}}});const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const s=await readFile(new URL('../src/components/PrivacyImages.jsx',import.meta.url),'utf8');const m=new vm.SourceTextModule((await transform(s,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(n=>{if(n==='react')return moduleOf(React);if(n==='react/jsx-runtime')return moduleOf(jsx);if(n==='../api')return moduleOf({api});if(n==='../lib/fileDownload')return moduleOf({saveBlob:async()=>{}});if(n==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});throw Error(n);});await m.evaluate();return m.namespace;
}

test('only selected RGB pixels leave browser, transparent pixels flatten and invalid bounds fail',async()=>{const {selectedPixels}=await components();assert.deepEqual(Array.from(selectedPixels(new Uint8ClampedArray([255,0,0,255,99,88,77,255]),2,1,[{x:0,y:0,width:1,height:1}])),[255,0,0,0,0,0]);assert.deepEqual(Array.from(selectedPixels(new Uint8ClampedArray([9,8,7,0]),1,1,[{x:0,y:0,width:1,height:1}])),[255,255,255]);for(const r of [[],[{x:0,y:0,width:3,height:1}],[{x:0.5,y:0,width:1,height:1}]])assert.throws(()=>selectedPixels(new Uint8ClampedArray(8),2,1,r));});
test('admin has no default scope or source and excludes unconfirmed company scopes',async()=>{const {AdminImages}=await components({}, {'admin-privacy-images':{items:[],events:[]},'privacy-image-companies':{items:[{id:1,identity:'pending',staff_id:1},{id:2,identity:'confirmed',staff_id:null},{id:3,identity:'confirmed',staff_id:1,status:'in_review'}]}});let r;await act(async()=>{r=create(React.createElement(AdminImages,{request:{id:1,revision:1,status:'in_review',due_at:'2099-01-01'}}));});assert.equal(r.root.findAllByType('select')[0].props.value,'');assert.equal(r.root.findAllByType('img').length,0);assert.equal(r.root.findAllByType('option').some(x=>x.props.value===1),false);assert.equal(r.root.findAllByType('option').some(x=>x.props.value===3),true);await act(async()=>r.unmount());});
test('image downloads require available grant and clear password on failure and request switch',async()=>{const {PersonalImages}=await components({downloadPrivacyImage:async()=>{throw Error('제공 종료');}},{'personal-privacy-images':{items:[{id:1,category:'receipt',notice:'일부',available:true,expires_at:'2099-01-01'}]}});let r;await act(async()=>{r=create(React.createElement(PersonalImages,{request:{id:1,status:'cancelled'}}));});assert.equal(r.root.findAllByType('input').length,0);await act(async()=>r.update(React.createElement(PersonalImages,{request:{id:1,status:'in_review'}})));await act(async()=>r.root.findByType('input').props.onChange({target:{value:'test-only'}}));await act(async()=>r.root.findByType('button').props.onClick());assert.equal(r.root.findByType('input').props.value,'');assert.equal(r.root.findAllByProps({role:'status'}).length,0);await act(async()=>r.root.findByType('input').props.onChange({target:{value:'test-only'}}));await act(async()=>r.update(React.createElement(PersonalImages,{request:{id:2,status:'in_review'}})));assert.equal(r.root.findByType('input').props.value,'');await act(async()=>r.unmount());});
test('receipt source controls require selected confirmed expense scope and disappear on personal scope or review invalidation',async()=>{
 const company={id:9,revision:1,identity:'confirmed',staff_id:24,status:'in_review',category:'expenses',from_at:'2026-11-01',until_at:'2026-11-07'};
 const queries={'privacy-image-companies':{items:[company]},'privacy-receipt-sources':{items:[{id:61,expense_id:30,spent_on:'2026-11-05',category:'유류비',amount_krw:30000}]}};
 const {AdminImages}=await components({},queries);let r;const request={id:1,revision:1,status:'in_review',due_at:'2099-01-01'};
 await act(async()=>{r=create(React.createElement(AdminImages,{request}));});
 const buttons=()=>r.root.findAllByType('button').filter(b=>b.children.join('')==='원본 확인·불러오기');assert.equal(buttons().length,0);
 await act(async()=>r.root.findAllByType('select')[0].props.onChange({target:{value:'9'}}));assert.equal(buttons().length,1);
 company.identity='pending';await act(async()=>r.update(React.createElement(AdminImages,{request:{...request,revision:2}})));assert.equal(buttons().length,0);
 await act(async()=>r.root.findAllByType('select')[0].props.onChange({target:{value:'personal'}}));assert.equal(buttons().length,0);await act(async()=>r.unmount());
});
test('reduction keeps the aspect ratio inside 2048px and one megapixel like the server',async()=>{
 const {fitSize}=await components();
 for(const size of [[1,1],[1000,1000],[2048,488],[640,480]])assert.deepEqual(Array.from(fitSize(...size)),size);
 assert.deepEqual(Array.from(fitSize(4000,3000)),[1154,865]);assert.deepEqual(Array.from(fitSize(3000,4000)),[865,1154]);
 assert.deepEqual(Array.from(fitSize(2049,1)),[2048,1]);assert.deepEqual(Array.from(fitSize(1,16384)),[1,2048]);assert.deepEqual(Array.from(fitSize(2048,2048)),[1000,1000]);
 for(let i=0,seed=7;i<2000;i++){seed=(seed*1103515245+12345)%2147483648;const w=1+seed%16384,h=1+(seed>>>9)%16384,[tw,th]=fitSize(w,h);assert.ok(tw>=1&&th>=1&&tw<=w&&th<=h&&tw<=2048&&th<=2048&&tw*th<=1000000,`${w}x${h}`);}
});
test('reviewer and delivery history say when a source was reduced or turned upright',async()=>{
 const normalization={version:2,reduced:true,source_width:4000,source_height:3000,width:865,height:1154,orientation:6};
 const {sourceNote,AdminImages}=await components({},{'admin-privacy-images':{items:[{id:5,category:'receipt',notice:'일부',source_reference:'지출 #30 / 영수증 #61',receipt_id:61,company_review_id:9,source_normalization:normalization,available:true,expires_at:'2099-01-01'},{id:4,category:'photo',notice:'일부',source_reference:'수동',company_review_id:null,source_normalization:null,available:true,expires_at:'2099-01-01'}],events:[]},'privacy-image-companies':{items:[]}});
 assert.equal(sourceNote(normalization),'원본 4000 × 3000px 축소 · 촬영 방향 보정(시계 방향 90° 회전)');
 assert.equal(sourceNote({reduced:false,orientation:1}),'');assert.equal(sourceNote({reduced:false,orientation:3}),'촬영 방향 보정(180° 회전)');assert.equal(sourceNote(null),'');assert.equal(sourceNote(undefined),'');
 let r;await act(async()=>{r=create(React.createElement(AdminImages,{request:{id:1,revision:1,status:'in_review',due_at:'2099-01-01'}}));});
 const lines=r.root.findAllByType('p').map(p=>p.children.filter(c=>typeof c==='string').join(''));
 assert.equal(lines.filter(t=>t.includes('원본 4000 × 3000px 축소')).length,1);assert.ok(lines.some(t=>t.startsWith('수동')&&!t.includes('축소')));
 await act(async()=>r.unmount());
});
test('PDF sources are labelled by page in the list, the note and the delivery history',async()=>{
 const pdf={version:3,kind:'pdf',page:2,pages:5,page_width_pt:595.276,page_height_pt:841.89,width:840,height:1189,renderer_sha256:'ab'.repeat(32)};
 const company={id:9,revision:1,identity:'confirmed',staff_id:24,status:'in_review',category:'expenses',from_at:'2026-11-01',until_at:'2026-11-07'};
 const queries={'privacy-image-companies':{items:[company]},'privacy-receipt-sources':{items:[{id:61,expense_id:30,spent_on:'2026-11-05',category:'유류비',amount_krw:30000,mime:'image/jpeg'},{id:62,expense_id:31,spent_on:'2026-11-05',category:'보험',amount_krw:120000,mime:'application/pdf'}]},'admin-privacy-images':{items:[{id:7,category:'receipt',notice:'일부',source_reference:'지출 #31 / 영수증 #62 / 2쪽',receipt_id:62,company_review_id:9,source_normalization:pdf,source_page:2,available:true,expires_at:'2099-01-01'}],events:[]}};
 const {sourceNote,AdminImages}=await components({},queries);
 assert.equal(sourceNote(pdf),'PDF 2/5쪽 · 서버가 원본에서 그린 쪽');
 let r;await act(async()=>{r=create(React.createElement(AdminImages,{request:{id:1,revision:1,status:'in_review',due_at:'2099-01-01'}}));});
 await act(async()=>r.root.findAllByType('select')[0].props.onChange({target:{value:'9'}}));
 const rows=r.root.findAllByType('span').map(s=>s.children.filter(c=>typeof c==='string').join(''));
 assert.equal(rows.filter(t=>t.includes('영수증 #62')&&t.endsWith(' · PDF')).length,1);assert.equal(rows.filter(t=>t.includes('영수증 #61')&&t.includes('PDF')).length,0);
 const lines=r.root.findAllByType('p').map(p=>p.children.filter(c=>typeof c==='string').join(''));
 assert.equal(lines.filter(t=>t.includes('지출 #31 / 영수증 #62 / 2쪽')&&t.includes('PDF 2/5쪽')).length,1);
 await act(async()=>r.unmount());
});
