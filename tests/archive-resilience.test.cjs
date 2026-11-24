const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function setup(){
  const elements={};
  const ctx=vm.createContext({URL,URLSearchParams,structuredClone,Blob,console,setTimeout,chrome:{storage:{local:{get:()=>new Promise(()=>{})}}},document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:''})}});
  for(const file of ['core.js','updates.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),ctx);
  vm.runInContext(`issue={key:'X-22155',url:'https://jira.mos.social/browse/X-22155',images:[]};job={id:'run-1',downloads:[]};
    cache=new Map();downloads=[];calls=[];saved=[];
    fileStore=async(key,file)=>{if(file!==undefined)cache.set(key,file);return cache.get(key);};
    save=async()=>{saved.push(structuredClone(job));};
    download=async(blob,name)=>{downloads.push(name);};
    archive=async(url,name)=>{calls.push(url);if(url.includes('unavailable'))throw Error('Frame with ID 0 is showing error page');return {name,url,blob:new Blob(['archive'])};};
  `,ctx);return ctx;
}
test('Chrome error page is skipped and later archives are downloaded normally',async()=>{
  const ctx=setup();
  const files=await vm.runInContext("filesFor({},['https://unavailable.example/page','https://working.example/page'])",ctx);
  assert.equal(files.length,1);assert.equal(files[0].url,'https://working.example/page');
  assert.equal(vm.runInContext('job.skippedPages.length',ctx),1);
  assert.equal(vm.runInContext('downloads.length',ctx),1);
  assert.match(vm.runInContext('job.skippedPages[0].reason',ctx),/Chrome/);
  assert(vm.runInContext('saved.some(s=>s.skippedPages.length===1)',ctx));
});
test('unavailable source MHTML does not discard the already-read issue description',async()=>{
  const ctx=setup();vm.runInContext("issue.url='https://unavailable.example/source';issue.description='Already read Jira description';",ctx);
  const files=await vm.runInContext('filesFor({},[issue.url])',ctx);
  assert.equal(files.length,0);assert.equal(vm.runInContext('issue.description',ctx),'Already read Jira description');
  assert.equal(vm.runInContext('job.skippedPages.length',ctx),1);
});
test('a skipped page is attempted again on retry and the warning clears if it becomes available',async()=>{
  const ctx=setup();await vm.runInContext("filesFor({},['https://unavailable.example/page'])",ctx);
  vm.runInContext("archive=async(url,name)=>({name,url,blob:new Blob(['recovered'])});",ctx);
  const files=await vm.runInContext("filesFor({},['https://unavailable.example/page'])",ctx);
  assert.equal(files.length,1);assert.equal(vm.runInContext('job.skippedPages.length',ctx),0);
});
test('authentication and permission failures are not silently skipped',async()=>{
  for(const message of ['Войдите в систему','Cannot access contents of the page. Extension manifest must request permission']){
    const ctx=setup();ctx.failure=message;vm.runInContext('archive=async()=>{throw Error(failure);};',ctx);
    await assert.rejects(vm.runInContext("filesFor({},['https://example.com'])",ctx),e=>e.message===message);
    assert.equal(vm.runInContext('job.skippedPages.length',ctx),0);
  }
});
test('local download failures still stop instead of losing required files',async()=>{
  const ctx=setup();vm.runInContext("download=async()=>{throw Error('disk failure');};",ctx);
  await assert.rejects(vm.runInContext("filesFor({},['https://working.example/page'])",ctx),/disk failure/);
  assert.equal(vm.runInContext('job.skippedPages.length',ctx),0);
});
test('image download failures are not treated as an optional MHTML failure',async()=>{
  const ctx=setup();vm.runInContext("issue.images=['https://example.com/image.png'];get=async()=>{throw Error('Frame with ID 0 is showing error page');};",ctx);
  await assert.rejects(vm.runInContext('filesFor({},[])',ctx),/Frame with ID/);
});
test('final report includes skipped links and preserves earlier field-validation warnings',()=>{
  const ctx=setup();vm.runInContext("job.skippedPages=[{url:'https://unavailable.example/page'}];document.getElementById('status').textContent='Задача создана, но дата не подтверждена.';reportSkippedPages();",ctx);
  const message=vm.runInContext("document.getElementById('status').textContent",ctx);
  assert.match(message,/дата не подтверждена/);assert.match(message,/https:\/\/unavailable/);assert.match(message,/не сохранены MHTML/);
});
test('timeouts and connection failures are classified without swallowing arbitrary exceptions',()=>{
  const ctx=setup();
  assert(vm.runInContext("C.unavailableArchiveReason(Error('net::ERR_NAME_NOT_RESOLVED'))",ctx));
  assert(vm.runInContext("C.unavailableArchiveReason(Error('Страница долго загружается.'))",ctx));
  assert.equal(vm.runInContext("C.unavailableArchiveReason(Error('Cannot read properties of undefined'))",ctx),null);
});
test('the complete transfer proceeds to task creation after skipping an unavailable linked site',async()=>{
  const ctx=setup();ctx.crypto=require('node:crypto').webcrypto;
  vm.runInContext(`issue.subject='Task [22155]';issue.description='source description';job=null;
    settings=()=>({jira:{key:'X-22155'},destination:'redmine',requester:'Денис Мезенцев'});
    API.storage.local.get=async()=>({});API.storage.local.set=async()=>{};API.permissions={contains:async()=>true};
    document.getElementById('links').querySelectorAll=()=>[{value:'https://unavailable.example/page'},{value:'https://working.example/page'}];
    read=async()=>{};findExisting=async()=>null;versionFiles=async files=>files;
    created=0;createRedmine=async(s,files)=>{created++;job.stage='done';log('Задача создана. Файлы: '+files.length);};
  `,ctx);
  await vm.runInContext('transfer()',ctx);
  assert.equal(vm.runInContext('created',ctx),1);assert.equal(vm.runInContext('job.stage',ctx),'done');
  assert.equal(vm.runInContext('job.skippedPages.length',ctx),1);
  assert.match(vm.runInContext("document.getElementById('status').textContent",ctx),/Задача создана.*Предупреждение/);
});
