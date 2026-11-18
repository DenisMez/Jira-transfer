const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function background(existing=false) {
  let listener,hasEngine=existing;const events=[];let tabs=existing?[{id:17,windowId:2}]:[];
  const chrome={runtime:{id:'local-extension',getURL:p=>'chrome-extension://local-extension/'+p,
    onMessage:{addListener:f=>{listener=f;}},getContexts:async()=>hasEngine?[{contextType:'OFFSCREEN_DOCUMENT'}]:[],
    sendMessage:async msg=>{events.push(msg);return msg.command==='snapshot'?{ready:true,busy:false}:{accepted:true};}},
    tabs:{query:async()=>tabs,create:async options=>{events.push({create:options});tabs=[{id:17,windowId:2}];return tabs[0];},
      update:async(id,options)=>{events.push({update:id,...options});},reload:async()=>{}},
    offscreen:{createDocument:async options=>{events.push({offscreen:options});hasEngine=true;}},
    windows:{update:async(id,options)=>events.push({window:id,...options})}};
  const ctx=vm.createContext({chrome,setTimeout,importScripts:()=>{}});
  vm.runInContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),ctx);
  const send=(command,data)=>new Promise(resolve=>listener({target:'controller',command,data},{id:chrome.runtime.id},resolve));
  return {send,events,listener,chrome};
}
test('popup start creates an offscreen engine and no extension tab',async()=>{
  const b=background();
  assert.equal((await b.send('read',{source:'url'})).accepted,true);
  assert.equal(b.events.filter(e=>e.create).length,0);
  assert.equal(b.events.find(e=>e.offscreen).offscreen.url,'engine.html');
  const command=b.events.find(e=>e.command==='read');
  assert.equal(command.target,'runner');assert.equal(command.tabId,undefined);assert.equal(command.data.source,'url');
});
test('reopening popup reuses the runner without starting a second operation',async()=>{
  const b=background(true);
  await b.send('snapshot');await b.send('snapshot');
  assert.equal(b.events.filter(e=>e.create).length,0);
  assert.equal(b.events.filter(e=>e.command==='read'||e.command==='transfer').length,0);
});
test('concurrent popup requests create one offscreen engine and zero tabs',async()=>{
  const b=background();await Promise.all([b.send('snapshot'),b.send('snapshot')]);
  assert.equal(b.events.filter(e=>e.offscreen).length,1);
  assert.equal(b.events.filter(e=>e.create).length,0);
});
test('settings button focuses working tab without submitting a task',async()=>{
  const b=background(true);await b.send('open');
  assert(b.events.some(e=>e.update===17&&e.active===true));
  assert.equal(b.events.filter(e=>e.command==='transfer').length,0);
  assert.equal(b.events.filter(e=>e.offscreen).length,0);
});
test('popup is registered and loads only local scripts',()=>{
  const manifest=JSON.parse(fs.readFileSync(require.resolve('../manifest.json'),'utf8'));
  assert.equal(manifest.action.default_popup,'popup.html');
  const html=fs.readFileSync(require.resolve('../popup.html'),'utf8');
  for(const match of html.matchAll(/(?:src|href)="([^"#]+)"/g)){
    assert(!match[1].includes('://'));assert(fs.existsSync(require.resolve('../'+match[1])));
  }
  const engine=fs.readFileSync(require.resolve('../engine.html'),'utf8');
  assert(engine.includes('src="rpc.js"'));assert(engine.includes('src="app.js"'));assert(!engine.includes('src="full.js"'));
  const full=fs.readFileSync(require.resolve('../index.html'),'utf8');assert(full.includes('src="full.js"'));assert(!full.includes('src="app.js"'));
});
test('API bridge accepts only the offscreen document and a fixed operation allowlist',async()=>{
  const b=background();
  const unauthorized=await new Promise(resolve=>b.listener({target:'api',method:'tabs.query',args:[{}]},{id:b.chrome.runtime.id,url:'chrome-extension://local-extension/popup.html'},resolve));
  assert.match(unauthorized.error,/Недопустимый отправитель/);
  const unsupported=await new Promise(resolve=>b.listener({target:'api',method:'tabs.remove',args:[1]},{id:b.chrome.runtime.id,url:'chrome-extension://local-extension/engine.html'},resolve));
  assert.match(unsupported.error,/не разрешена/);
});
test('runner acknowledges popup command before the long operation finishes',async()=>{
  let listener,finish;
  const elements={};
  const chrome={runtime:{id:'local-extension',onMessage:{addListener:f=>{listener=f;}}},
    tabs:{getCurrent:async()=>({id:17})},storage:{local:{get:()=>new Promise(()=>{})}}};
  const ctx=vm.createContext({chrome,URL,console,setTimeout,document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:''})}});
  vm.runInContext(fs.readFileSync(require.resolve('../core.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8'),ctx);
  ctx.work=new Promise(resolve=>{finish=resolve;});
  vm.runInContext('runnerReady=true;guard=async()=>{busy=true;await work;busy=false;};',ctx);
  const reply=await new Promise(resolve=>listener({target:'runner',tabId:17,command:'read',data:{source:'jira-url',date:'2026-11-23'}},{id:'local-extension'},resolve));
  assert.equal(reply.accepted,true);
  assert.equal(vm.runInContext('busy',ctx),true);
  assert.equal(elements.source.value,'jira-url');
  // No popup context remains necessary to finish the already-started operation.
  finish();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(vm.runInContext('busy',ctx),false);
});
