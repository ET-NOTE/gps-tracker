import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

async function fixture() {
 const document=new EventTarget(); const observers=[];
 const element=(name,parent=null)=>({name,parent,inert:false,isConnected:true,tabIndex:0,fields:[],
  focus(){document.activeElement=this;document.dispatchEvent(new Event('focusin'));},
  closest(){let n=this;while(n){if(n.inert)return n;n=n.parent;}return null;},
  contains(n){while(n){if(n===this)return true;n=n.parent;}return false;},
  querySelectorAll(){return this.fields;},getClientRects(){return this.hidden?[]:[{}];},matches(){return this.name==='input';}});
 const root=element('root'),opener=element('opener',root);
 document.body={children:[root],style:{overflow:'auto'}};document.activeElement=opener;
 const context=vm.createContext({document,Map,Array,getComputedStyle:()=>({visibility:'visible'}),MutationObserver:class{constructor(fn){observers.push(fn);}observe(){}disconnect(){}}});
 const mod=new vm.SourceTextModule(await readFile(new URL('../src/lib/modalFocus.js',import.meta.url),'utf8'),{context});await mod.link(()=>{});await mod.evaluate();
 const modal=()=>{const backdrop=element('backdrop'),dialog=element('dialog',backdrop),first=element('close',dialog),input=element('input',dialog),last=element('last',dialog);dialog.fields=[first,input,last];document.body.children.push(backdrop);return{backdrop,dialog,first,input,last};};
 const key=(key,shiftKey=false)=>{const e=new Event('keydown',{cancelable:true});Object.assign(e,{key,shiftKey});document.dispatchEvent(e);return e;};
 return {document,root,opener,modal,key,lock:mod.namespace.lockModalFocus,observers};
}
test('modal: initial field, forward/backward boundaries, outside focus and opener restoration',async()=>{
 const f=await fixture(),m=f.modal();const unlock=f.lock(m.dialog,m.backdrop,()=>({closeOnEsc:true}));
 assert.equal(f.document.activeElement,m.input);assert.equal(f.root.inert,true);
 m.last.focus();assert.equal(f.key('Tab').defaultPrevented,true);assert.equal(f.document.activeElement,m.first);
 f.key('Tab',true);assert.equal(f.document.activeElement,m.last);
 f.opener.focus();assert.equal(f.document.activeElement,m.input);
 unlock();assert.equal(f.root.inert,false);assert.equal(f.document.activeElement,f.opener);assert.equal(f.document.body.style.overflow,'auto');
});
test('modal: nested dialogs only close the top and retain background/scroll lock',async()=>{
 const f=await fixture(),a=f.modal();let closedA=0,closedB=0;
 const undoA=f.lock(a.dialog,a.backdrop,()=>({closeOnEsc:true,onClose:()=>closedA++}));a.last.focus();
 const b=f.modal(),undoB=f.lock(b.dialog,b.backdrop,()=>({closeOnEsc:true,onClose:()=>closedB++}));
 assert.equal(a.backdrop.inert,true);assert.equal(b.backdrop.inert,false);
 f.key('Escape');assert.equal(closedA,0);assert.equal(closedB,1);
 undoB();assert.equal(a.backdrop.inert,false);assert.equal(f.root.inert,true);assert.equal(f.document.activeElement,a.last);assert.equal(f.document.body.style.overflow,'hidden');
 undoA();assert.equal(f.root.inert,false);assert.equal(f.document.body.style.overflow,'auto');
});
test('modal: latest close policy is used without refocusing an edited field',async()=>{
 const f=await fixture(),m=f.modal();let closed=0,options={closeOnEsc:false};
 const unlock=f.lock(m.dialog,m.backdrop,()=>options);m.last.focus();f.key('Escape');assert.equal(closed,0);
 options={closeOnEsc:true,onClose:()=>closed++};f.key('Escape');assert.equal(closed,1);assert.equal(f.document.activeElement,m.last);unlock();
});
