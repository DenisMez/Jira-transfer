const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {webcrypto}=require('node:crypto');require('../core.js');const C=TransferCore;
test('matching uses only the final five-digit number and tolerates renamed tasks',()=>{
  const rows=[{key:'KIS-1',subject:'Старое название[21856]'},{key:'KIS-3',subject:'Название [21857]'},{key:'KIS-4',subject:'Название 121856'},{key:'KIS-5',subject:'21856 в середине названия'}];
  assert.equal(C.pickExisting(rows,'Название [21856]','source').key,'KIS-1');
  assert.equal(C.pickExisting([{key:'KIS-1',subject:'Название 21856'}],'Название [21856]','source').key,'KIS-1');
  assert.equal(C.pickExisting(rows,'Совсем другое название [21856]','source').key,'KIS-1');
  assert.equal(C.pickExisting(rows,'Нет номера [21859]','source'),null);
});
test('duplicate final numbers stop updating even when the titles are different',()=>{
  assert.throws(()=>C.pickExisting([{key:'1',subject:'A [21856]'},{key:'2',subject:'B [21856]'}],'A [21856]','source'),/несколько/);
  assert.throws(()=>C.pickExisting([{key:'1',subject:'A [21856]',description:'Первоисточник: https://jira.mos.social/browse/X-21857'}],'A [21856]','https://jira.mos.social/browse/X-21856'),/другой первоисточник/);
});
test('the screenshot case updates the old hospitalization title by [21783]',()=>{
  const previous={id:'55397',subject:'МДГКБ. СИМИ. Не выгрузилась госпитализация пациента [21783]'};
  const updated='МДГКБ. СИМИ. Не выгружаются документы "Госпитализация в СИМИ" [21783]';
  assert.equal(C.pickExisting([previous],updated,'source').id,'55397');
  assert.throws(()=>C.pickExisting([previous,{id:'55398',subject:updated}],updated,'source'),/несколько/);
});
test('Jira update payload preserves workflow, assignee and project by omitting these fields',()=>{
  const fields={summary:{},description:{schema:{type:'string'}},duedate:{schema:{type:'date'}},status:{required:true},assignee:{required:true},customfield_1:{required:true}};
  const p=C.localUpdatePayload(fields,{localDeadline:'duedate',date:'2026-11-30'},'new description',{},'A [21856]');
  assert.deepEqual(Object.keys(p.fields).sort(),['description','duedate','summary']);
});
function context(){
  const elements={};const ctx=vm.createContext({URL,URLSearchParams,console,setTimeout,structuredClone,Blob,crypto:webcrypto,chrome:{storage:{local:{get:()=>new Promise(()=>{})}}},document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:''})}});
  for(const file of ['core.js','injected.js','updates.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),ctx);
  return ctx;
}
test('same-size changed images get distinct names and only attachment references are rewritten',async()=>{
  const ctx=context();ctx.Blob=Blob;
  vm.runInContext("issue={description:'Text !{width:800px}image-1.png!',jiraDescription:'!image-1.png|width=800!',imageNames:{url:'image-1.png'}};",ctx);
  const first=await vm.runInContext("versionFiles([{name:'image-1.png',blob:new Blob(['aa'])}])",ctx);
  assert(vm.runInContext('issue.description',ctx).includes(first[0].name));
  vm.runInContext("issue={description:'!image-1.png!',imageNames:{url:'image-1.png'}};",ctx);
  const second=await vm.runInContext("versionFiles([{name:'image-1.png',blob:new Blob(['bb'])}])",ctx);
  assert.notEqual(first[0].name,second[0].name);
});
test('Jira search checks all pages, including closed issues, before deciding',async()=>{
  const ctx=context();vm.runInContext(`issue={subject:'A [21856]',url:'source'};requests=[];
    localRequest=async path=>{requests.push(path);return {status:200,data:{total:2,issues:path.includes('startAt=0')?[{key:'KIS-1',fields:{summary:'Different [21857]'}}]:[{key:'KIS-2',fields:{summary:'Old name [21856]'}}]}};};`,ctx);
  const found=await vm.runInContext("findExisting({destination:'jira'})",ctx);
  assert.equal(found.key,'KIS-2');assert.equal(vm.runInContext('requests.length',ctx),2);
  assert(!decodeURIComponent(vm.runInContext('requests[0]',ctx)).includes('status'));
});
test('failed Jira search cannot fall back to creation',async()=>{
  const ctx=context();vm.runInContext("issue={subject:'A [21856]',url:'source'};localRequest=async()=>({status:403,data:{errorMessages:['forbidden']}});",ctx);
  await assert.rejects(vm.runInContext("findExisting({destination:'jira'})",ctx),/forbidden/);
});
test('completed history refreshes source and updates a matching task instead of creating',async()=>{
  const ctx=context();
  vm.runInContext(`settings=()=>({source:'source',jira:{key:'X-21856'},requester:'Денис Мезенцев',destination:'redmine',date:'2026-11-30'});
    issue={key:'X-21856',url:'https://jira.mos.social/browse/X-21856',subject:'A [21856]',images:[],description:'old'};
    job={stage:'done',source:'https://jira.mos.social/browse/X-21856',destination:'redmine',result:'existing'};
    API.storage.local.get=async()=>({});API.storage.local.set=async()=>{};API.permissions={contains:async()=>true};
    document.getElementById('links').querySelectorAll=()=>[];
    reads=0;updated=0;created=0;searches=0;
    read=async()=>{reads++;issue.description='fresh';};save=async()=>{};
    findExisting=async()=>{searches++;return {id:'99',url:'existing',subject:'A [21856]'};};
    filesFor=async()=>[];versionFiles=async f=>f;
    updateRedmine=async(s,f,t)=>{updated++;if(issue.description!=='fresh')throw Error('stale source');};
    createRedmine=async()=>{created++;};
  `,ctx);
  await vm.runInContext('transfer()',ctx);
  assert.equal(vm.runInContext('reads',ctx),1);assert.equal(vm.runInContext('updated',ctx),1);assert.equal(vm.runInContext('created',ctx),0);
});
test('a task appearing during archive capture is updated by the second search',async()=>{
  const ctx=context();
  vm.runInContext(`settings=()=>({source:'source',jira:{key:'X-21856'},requester:'Денис Мезенцев',destination:'redmine',date:'2026-11-30'});
    issue={key:'X-21856',url:'https://jira.mos.social/browse/X-21856',subject:'A [21856]',images:[],description:'fresh'};job=null;
    API.storage.local.get=async()=>({});API.storage.local.set=async()=>{};API.permissions={contains:async()=>true};
    document.getElementById('links').querySelectorAll=()=>[];
    updated=0;created=0;searches=0;read=async()=>{};save=async()=>{};
    findExisting=async()=>++searches===1?null:{id:'99',url:'existing',subject:'A [21856]'};
    filesFor=async()=>[];versionFiles=async f=>f;updateRedmine=async()=>{updated++;};createRedmine=async()=>{created++;};
  `,ctx);
  await vm.runInContext('transfer()',ctx);
  assert.equal(vm.runInContext('searches',ctx),2);assert.equal(vm.runInContext('created',ctx),0);assert.equal(vm.runInContext('updated',ctx),1);
});
test('existing Jira issue is updated by PUT and never created again, even after lost response',async()=>{
  const ctx=context();
  vm.runInContext(`job={localKey:'KIS-99',mode:'update',stage:'preparing'};save=async()=>{};recordCompletion=async()=>{};
    writes=[];description='old';lost=true;
    localRequest=async(path,method='GET',body)=>{
      if(method==='PUT'){writes.push({path,body});description=body.fields.description;if(lost){lost=false;throw Error('lost update response');}return {status:204};}
      if(method==='POST')throw Error('must not create');
      return {status:200,data:{fields:{attachment:[],description,duedate:'2026-11-30'}}};
    };
    prepared={payload:{fields:{summary:'A [21856]',description:'new',duedate:'2026-11-30'}},deadlineKey:'duedate'};
  `,ctx);
  await assert.rejects(vm.runInContext('transferLocal({},[],prepared)',ctx),/lost update/);
  assert.equal(vm.runInContext('job.stage',ctx),'updating');
  await vm.runInContext('transferLocal({},[],prepared)',ctx);
  assert.equal(vm.runInContext('job.localKey',ctx),'KIS-99');assert.equal(vm.runInContext('job.stage',ctx),'done');
  assert.equal(vm.runInContext('writes.length',ctx),2);
});
test('Redmine update sends only source-controlled fields and leaves status and assignee untouched',async()=>{
  const ctx=context();let current='old',subject='Old name [21856]',version=1,sent;
  const deadline={id:'due',name:'issue[custom_field_values][4]',value:'2026-11-30'};
  const requester={id:'who',name:'issue[custom_field_values][5]',value:'17',options:[{value:'17',textContent:'Мезенцев Денис'}]};
  const labels=[{textContent:'Выполнить до',htmlFor:'due'},{textContent:'Постановщик задачи',htmlFor:'who'}];
  const form={action:'https://rm.oblteh.ru/redmine/issues/99',elements:[{name:'authenticity_token',value:'token'},{name:'issue[lock_version]',value:'1'}],querySelectorAll:()=>labels};
  const doc={querySelector:q=>q==='#issue_subject'?{form,value:subject}:q==='#issue_description'?{value:current}:null,querySelectorAll:()=>[],getElementById:id=>id==='due'?deadline:requester};
  class FormData{constructor(){this.data=new Map();}set(k,v){this.data.set(k,v);}has(k){return this.data.has(k);}append(k,v){this.data.set(k,v);}}
  ctx.FormData=FormData;ctx.DOMParser=class{parseFromString(){return doc;}};
  ctx.fetch=async(url,options={})=>{if(options.method==='POST'){sent=options.body.data;current=sent.get('issue[description]');subject=sent.get('issue[subject]');version++;}return {ok:true,status:200,text:async()=>''};};
  const result=await vm.runInContext("Injected.updateRedmine({redmine:'https://rm.oblteh.ru/redmine',requester:'Денис Мезенцев',date:'2026-11-30',deadlineLabel:'Выполнить до'},{subject:'New name [21856]',description:'new',url:'source'},[],{id:'99',subject:'Old name [21856]',url:'https://rm.oblteh.ru/redmine/issues/99'})",ctx);
  assert.equal(result.ok,true);assert.equal(sent.get('_method'),'put');assert.equal(sent.get('issue[description]'),'new');
  assert.equal(sent.get('issue[subject]'),'New name [21856]');
  assert(!sent.has('issue[status_id]'));assert(!sent.has('issue[assigned_to_id]'));assert(!sent.has('issue[deleted_attachment_ids][]'));
});
test('Redmine search includes closed tasks and follows every next page',async()=>{
  const ctx=context(),requests=[];
  function row(id,title){return {id:'issue-'+id,querySelectorAll:()=>[{getAttribute:()=>'/redmine/issues/'+id,textContent:title}]};}
  const pages={
    form:{querySelector:()=>null,querySelectorAll:()=>[{value:'7',textContent:'» КИС ЕМИАС'}]},
    first:{querySelector:s=>s==='table.issues, .nodata'?{}:s.includes('.pagination')?{getAttribute:()=>'/redmine/issues?page=2'}:null,querySelectorAll:s=>s==='tr.issue'?[row('1','Other [21856]')]:[]},
    second:{querySelector:s=>s==='table.issues, .nodata'?{}:null,querySelectorAll:s=>s==='tr.issue'?[row('2','A [21856]')]:[]}
  };
  ctx.DOMParser=class{parseFromString(text){return pages[text];}};
  ctx.fetch=async url=>{requests.push(url);return {ok:true,text:async()=>url.endsWith('/issues/new')?'form':url.includes('page=2')?'second':'first'};};
  const result=await vm.runInContext("Injected.searchRedmine({redmine:'https://rm.oblteh.ru/redmine',project:'КИС ЕМИАС'},'21856')",ctx);
  assert.equal(result.length,2);assert.equal(result[1].id,'2');assert.equal(requests.length,3);
  const query=new URL(requests[1]).searchParams;
  assert.equal(query.get('op[status_id]'),'*');assert.equal(query.get('v[project_id][]'),'7');
});
