const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(previous){
  const elements={};const state={job:previous,completions:{existing:{result:'preserved'}}};
  const chrome={storage:{local:{get:()=>new Promise(()=>{}),set:async()=>{}}}};
  const ctx=vm.createContext({chrome,URL,URLSearchParams,structuredClone,console,setTimeout,document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:'',checked:false})}});
  for(const file of ['core.js','updates.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),ctx);
  chrome.storage.local.get=async()=>structuredClone(state);
  chrome.storage.local.set=async values=>Object.assign(state,structuredClone(values));
  ctx.previous=structuredClone(previous);
  vm.runInContext(`job=previous;issue={key:'X-21784',url:'https://jira.mos.social/browse/X-21784',subject:'New task [21784]'};
    document.getElementById('source').value=issue.url;
    document.getElementById('date').value='2026-11-30';
    document.getElementById('requester').value='Денис Мезенцев';
  `,ctx);
  return {ctx,state,elements,chrome};
}
test('reset releases an unfinished upload and preserves new task inputs and completed history',async()=>{
  const {ctx,state,elements}=setup({id:'old',stage:'uploading',source:'https://jira.mos.social/browse/X-21783',destination:'jira',localKey:'KIS-99',result:'http://jira.oblteh:8080/browse/KIS-99',sourceIssue:{description:'old'},downloads:['old-file']});
  assert.equal((await vm.runInContext('resetTransfer()',ctx)).ok,true);
  assert.equal(state.job,null);assert.equal(vm.runInContext('job',ctx),null);
  assert.equal(elements.source.value,'https://jira.mos.social/browse/X-21784');assert.equal(elements.date.value,'2026-11-30');assert.equal(elements.requester.value,'Денис Мезенцев');
  const hint=state.completions['jira|https://jira.mos.social/browse/X-21783'];
  assert.equal(hint.result,'http://jira.oblteh:8080/browse/KIS-99');assert.equal(hint.stage,'reset');
  assert.equal(hint.sourceIssue,undefined);assert.equal(hint.downloads,undefined);assert.equal(state.completions.existing.result,'preserved');
  assert.equal(vm.runInContext('busy',ctx),false);
});
test('after reset a different task proceeds to reading the source rather than the previous-transfer block',async()=>{
  const {ctx}=setup({stage:'updating',source:'old source',destination:'jira'});
  await vm.runInContext('resetTransfer()',ctx);
  vm.runInContext(`settings=()=>({jira:{key:'X-21784'},destination:'redmine'});read=async()=>{throw Error('new source read');};`,ctx);
  await assert.rejects(vm.runInContext('transfer()',ctx),/new source read/);
});
test('a live operation cannot be detached or reset',async()=>{
  const {ctx,state}=setup({stage:'uploading',source:'old'});
  vm.runInContext('busy=true;',ctx);
  await assert.rejects(vm.runInContext('resetTransfer()',ctx),/ещё выполняется/);
  assert.equal(state.job.stage,'uploading');assert.equal(vm.runInContext('job.stage',ctx),'uploading');assert.equal(vm.runInContext('busy',ctx),true);
});
test('reset works for an unknown creation result and records it without claiming server rollback',async()=>{
  const {ctx,state,elements}=setup({stage:'sending',source:'old',destination:'redmine'});
  await vm.runInContext('resetTransfer()',ctx);
  assert.equal(state.job,null);assert.equal(state.lastReset.stage,'sending');assert.equal(state.lastReset.result,null);
  assert.match(elements.status.textContent,/сброшен/);
});
test('storage failure leaves the old transfer state intact',async()=>{
  const {ctx,state,chrome}=setup({stage:'uploading',source:'old'});
  chrome.storage.local.set=async()=>{throw Error('storage failed');};
  await assert.rejects(vm.runInContext('resetTransfer()',ctx),/storage failed/);
  assert.equal(state.job.stage,'uploading');assert.equal(vm.runInContext('job.stage',ctx),'uploading');assert.equal(vm.runInContext('busy',ctx),false);
});
test('reset has no dependency on authorisation, Jira data or an existing transfer',async()=>{
  const {ctx,state}=setup(null);
  await vm.runInContext('resetTransfer()',ctx);await vm.runInContext('resetTransfer()',ctx);
  assert.equal(state.job,null);assert.equal(vm.runInContext('busy',ctx),false);
});
