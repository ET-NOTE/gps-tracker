import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function fixture() {
  const document = new EventTarget();
  const context=vm.createContext({console,document,URLSearchParams,setTimeout,clearTimeout,localStorage:{getItem:()=>null}});
  const modules=new Map();
  const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  async function load(file) {
    if(modules.has(file))return modules.get(file);
    const promise=(async()=>{
      let m;
      if(file==='react')m=synthetic(React);
      else if(file==='react/jsx-runtime')m=synthetic(jsx);
      else if(file.endsWith('.css'))m=synthetic({});
      else if(file.endsWith('.json'))m=synthetic({default:JSON.parse(await readFile(file,'utf8'))});
      else if(file.endsWith('/Icon.jsx'))m=synthetic({default:()=>null});
      else {let code=await readFile(file,'utf8');if(file.endsWith('.jsx'))code=(await transform(code,{loader:'jsx',jsx:'automatic',format:'esm'})).code;m=new vm.SourceTextModule(code,{context,identifier:file});}
      await m.link(async(name,parent)=>{
        if(!name.startsWith('.'))return load(name);
        let target=path.resolve(path.dirname(parent.identifier),name).replaceAll('\\','/');
        if(!/\.(js|jsx|css|json)$/.test(target)){try{await readFile(target+'.js');target+='.js';}catch{target+='.jsx';}}
        return load(target);
      });return m;
    })();modules.set(file,promise);return promise;
  }
  return {document,module:async name=>{const m=await load(fileURLToPath(new URL('../src/'+name,import.meta.url)).replaceAll('\\','/'));await m.evaluate();return m.namespace;}};
}

test('SIM explanation is hidden until hover, focus or tap; Escape and outside interaction close it',async()=>{
 const f=await fixture(), Help=(await f.module('components/SimRegistrationHelp.jsx')).default;
 let r;await act(async()=>{r=create(React.createElement(Help,{inputId:'sim'}),{createNodeMock:()=>({contains:target=>target==='inside'})});});
 const root=()=>r.root.findByProps({className:'sim-registration-label'}),button=()=>r.root.findByType('button');
 const visible=()=>r.root.findAllByProps({role:'tooltip'}).length;
 assert.equal(visible(),0);
 await act(async()=>button().props.onPointerEnter({pointerType:'touch'}));assert.equal(visible(),0);
 await act(async()=>button().props.onClick());assert.equal(visible(),1);
 await act(async()=>button().props.onClick());assert.equal(visible(),0);
 await act(async()=>button().props.onFocus());assert.equal(visible(),1);
 assert.match(JSON.stringify(r.toJSON()),/끝 8자리/);
 await act(async()=>root().props.onKeyDown({key:'Escape',stopPropagation(){}}));assert.equal(visible(),0);
 await act(async()=>button().props.onPointerEnter({pointerType:'mouse'}));assert.equal(visible(),1);
 await act(async()=>f.document.dispatchEvent(new Event('pointerdown')));assert.equal(visible(),0);
 await act(async()=>button().props.onFocus());
 await act(async()=>root().props.onBlur({currentTarget:{contains:()=>false},relatedTarget:null}));assert.equal(visible(),0);
 await act(async()=>r.unmount());
});

test('notification target parsing rejects invalid and duplicate identifiers and retains other query parameters',async()=>{
 const {readDeviceLink,withoutDeviceLink}=await(await fixture()).module('hooks/useDeviceDeepLink.js');
 assert.equal(readDeviceLink('?device=102').id,102);
 for(const value of ['','0','-1','1.5','x','9007199254740992','1&device=2'])assert.equal(readDeviceLink('?device='+value).id,null);
 assert.equal(readDeviceLink('?tab=account').present,false);
 assert.equal(withoutDeviceLink('?device=102&tab=notif'),'?tab=notif');
});

test('notification waits for membership and map, overrides saved selection, and handles another notification in the same session',async()=>{
 const {useDeviceDeepLink}=await(await fixture()).module('hooks/useDeviceDeepLink.js');
 const selected=[101],consumed=[];let latest,r;
 const callbacks={onSelect:id=>selected.push(id),onConsume:search=>consumed.push(search)};
 function Probe(props){latest=useDeviceDeepLink(props);return null;}
 const props={...callbacks,search:'?device=102&tab=other',devices:[],loaded:false,ready:false};
 await act(async()=>{r=create(React.createElement(Probe,props));});assert.deepEqual(selected,[101]);
 props.ready=true;await act(async()=>r.update(React.createElement(Probe,props)));assert.deepEqual(selected,[101]);
 props.loaded=true;props.devices=[{id:101},{id:102}];await act(async()=>r.update(React.createElement(Probe,props)));
 assert.deepEqual(selected,[101,102]);assert.deepEqual(consumed,['?tab=other']);assert.equal(latest.notice,'');
 props.search='?tab=other';await act(async()=>r.update(React.createElement(Probe,props)));
 props.search='?device=101';await act(async()=>r.update(React.createElement(Probe,props)));assert.equal(selected.at(-1),101);
 props.search='?device=999';await act(async()=>r.update(React.createElement(Probe,props)));
 assert.equal(selected.at(-1),null);assert.match(latest.notice,/찾을 수 없습니다/);
 await act(async()=>latest.dismiss());assert.equal(latest.notice,'');
 props.search='?device=invalid';await act(async()=>r.update(React.createElement(Probe,props)));assert.equal(selected.at(-1),null);
 await act(async()=>r.unmount());
});

test('Fleet shares the Home status: stale wake is offline and a fresh wake never proves driving',async()=>{
 const f=await fixture(),{classifyDevice}=await f.module('colors.js'),{fleetStatusGroup}=await f.module('lib/fleetStatus.js');
 const now=Date.now(),iso=offset=>new Date(now+offset).toISOString();
 const cases=[
  [{last_seen_at:iso(-86400000),last_event_kind:'wake'},'offline','offline'],
  [{last_seen_at:iso(0),last_fix_at:iso(0),last_event_kind:'wake'},'active','active'],
  [{last_seen_at:iso(0),last_event_kind:'wake'},'gps_loss','attention'],
  [{last_seen_at:iso(0),last_event_at:iso(0),last_event_kind:'sleep_enter'},'sleeping','idle'],
  [{last_seen_at:iso(-90000000),last_event_at:iso(-90000000),last_event_kind:'sleep_enter'},'lost','offline'],
  [{last_seen_at:iso(-87000000),last_event_at:iso(-87000000),last_event_kind:'sleep_enter',last_stationary:{timer_wake_enabled:true,timer_wake_s:86400}},'sleeping','idle'],
  [{last_seen_at:iso(-87400000),last_event_at:iso(-87400000),last_event_kind:'sleep_enter',last_stationary:{timer_wake_enabled:true,timer_wake_s:86400}},'lost','offline'],
  [{last_seen_at:'invalid'},'unknown','unknown'],
  [{last_seen_at:iso(0),last_fix_at:'invalid'},'gps_loss','attention'],
 ];
 for(const [d,status,group] of cases){assert.equal(classifyDevice(d,undefined,now).id,status);assert.equal(fleetStatusGroup(d,now),group);}
 assert.equal(classifyDevice(cases[1][0],undefined,now).label,'통신 정상');
 assert.equal(fleetStatusGroup(cases[1][0],now+31*60000),'offline','status expires even without another packet');
});
