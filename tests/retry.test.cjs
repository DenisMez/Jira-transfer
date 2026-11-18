const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup(job) {
  const values={source:'https://jira.mos.social/browse/X-1',date:'2026-11-23',redmine:'https://rm.oblteh.ru/redmine',project:'КИС ЕМИАС',tracker:'Доработка',priority:'Высокий',requester:'Мезенцев Денис',deadlineLabel:'Выполнить до',log:'',status:''};
  const elements=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,textContent:''}]));
  const chrome={storage:{local:{get:()=>new Promise(()=>{}),set:async()=>{throw Error('unexpected storage mutation');}}}};
  const ctx=vm.createContext({document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:''})},chrome,URL,console,setTimeout,TransferCore:global.TransferCore});
  vm.runInContext(fs.readFileSync(require.resolve('../core.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../injected.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../updates.js'),'utf8'),ctx);
  vm.runInContext(fs.readFileSync(require.resolve('../app.js'),'utf8'),ctx);
  vm.runInContext(`issue={key:'X-1',url:'https://jira.mos.social/browse/X-1'};job=${JSON.stringify(job)};`,ctx);
  return ctx;
}
test('uncertain submission blocks rereading and sending before any network or mutation',async()=>{
  const ctx=setup({source:'https://jira.mos.social/browse/X-1',stage:'sending'});
  await assert.rejects(vm.runInContext('read()',ctx),/Сначала проверьте/);
  await assert.rejects(vm.runInContext('transfer()',ctx),/Сначала проверьте/);
});
test('completed transfer refreshes the source instead of stopping at local completion history',async()=>{
  const ctx=setup({source:'https://jira.mos.social/browse/X-1',stage:'done',result:'https://rm.oblteh.ru/redmine/issues/123'});
  vm.runInContext("read=async()=>{throw Error('source refresh attempted');};",ctx);
  await assert.rejects(vm.runInContext('transfer()',ctx),/source refresh attempted/);
  assert.equal(vm.runInContext('job.result',ctx),'https://rm.oblteh.ru/redmine/issues/123');
});
test('MHTML of an empty description ignores 24 broken interface images',async()=>{
  const ctx=setup(null);
  vm.runInContext(`
    location={hostname:'jira.mos.social',href:'https://jira.mos.social/browse/X-1'};
    window={scrollTo:()=>{}};
    document.title='X-1 — Jira';
    document.documentElement={scrollHeight:0};
    document.images=Array.from({length:24},()=>({complete:true,naturalWidth:0}));
    document.querySelector=selector=>selector==='#description-val'?{querySelectorAll:()=>[]}:null;
    setTimeout=callback=>{callback();return 0;};
    tabFor=async()=>({id:1});
    inTab=async(id,name)=>Injected[name]();
    chrome.pageCapture={saveAsMHTML:async()=>({size:100})};
  `,ctx);
  const result=await vm.runInContext("archive('https://jira.mos.social/browse/X-1','source.mhtml')",ctx);
  assert.equal(result.name,'source.mhtml');
  assert.equal(result.blob.size,100);
});
test('linked Jira image becomes an inline Redmine image, not a quoted text link',()=>{
  const ctx=setup(null);
  vm.runInContext(`
    const picture={nodeType:1,tagName:'IMG',getAttribute:()=>'/secure/thumbnail/42/preview.png'};
    const link={nodeType:1,tagName:'A',childNodes:[picture],getAttribute:()=>'/secure/attachment/42/original.png',querySelector:()=>picture};
    DOMParser=class {parseFromString(){return {body:{childNodes:[link]}};}};
  `,ctx);
  const r=vm.runInContext("convert('', 'https://jira.mos.social/browse/X-1', {'https://jira.mos.social/secure/thumbnail/42/preview.png':'image-1.png'})",ctx);
  assert.equal(r.text,'!{width:800px}image-1.png!');
});
test('inline ZIP icon is omitted while its original download link remains readable',()=>{
  const ctx=setup(null);
  vm.runInContext(`
    const icon={nodeType:1,tagName:'IMG',getAttribute:()=>'/images/icons/attach/zip.gif'};
    const label={nodeType:3,textContent:'xml.zip'};
    const link={nodeType:1,tagName:'A',childNodes:[label,icon],getAttribute:()=>'/secure/attachment/43/xml.zip',querySelector:()=>icon};
    DOMParser=class {parseFromString(){return {body:{childNodes:[link]}};}};
  `,ctx);
  const r=vm.runInContext("convert('', 'https://jira.mos.social/browse/X-1', {'https://jira.mos.social/images/icons/attach/zip.gif':null})",ctx);
  assert.equal(r.text,'"xml.zip":https://jira.mos.social/secure/attachment/43/xml.zip');
});
