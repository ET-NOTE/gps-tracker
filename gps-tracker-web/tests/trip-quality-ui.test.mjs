import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as quality from '../src/lib/tripQuality.js';
import vm from 'node:vm';

test('trip summary distinguishes loading, failed and truly empty results',async()=>{
 const context=vm.createContext({});
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const source=await readFile(new URL('../src/components/business/TripQualitySummary.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',format:'esm'})).code,{context});
 await m.link(name=>name==='react'?synthetic({default:React}):synthetic(quality));await m.evaluate();
 const render=props=>renderToStaticMarkup(React.createElement(m.namespace.default,{onlyReview:false,onReviewChange:()=>{},...props}));
 for(const props of [{loading:true,trips:null},{loading:true,trips:[]},{error:'failed',trips:null}])assert.doesNotMatch(render(props),/0건|0.00/);
 assert.match(render({loading:true,trips:null}),/aria-busy="true"/);
 assert.match(render({vehicleSelected:false,trips:null}),/차량을 선택/);
 assert.doesNotMatch(render({vehicleSelected:false,trips:null}),/aria-busy|0건/);
 assert.match(render({trips:[]}),/0건/);
 assert.match(render({trips:[{started_at:'2026-10-20T01:00Z',ended_at:'2026-10-20T02:00Z',distance_m:1250,quality:{report_included:true}}]}),/1.25/);
});
