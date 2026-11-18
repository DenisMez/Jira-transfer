const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
require('../core.js');const C=global.TransferCore;
test('local Jira keeps native wiki styles and replaces image and source attachment references',()=>{
  const text=C.jiraDescription('*Заголовок*\n!screen (1).png|thumbnail!\n[^xml.zip]\n[KISEMIAS2019-21890]',{'screen (1).png':'image-1.png'},[{filename:'xml.zip',content:'https://jira.mos.social/secure/attachment/7/xml.zip'}],'https://jira.mos.social/browse/X-1');
  assert(text.includes('*Заголовок*'));assert(text.includes('!image-1.png|width=800!'));assert(text.includes('[xml.zip|https://jira.mos.social/secure/attachment/7/xml.zip]'));assert(text.includes('[KISEMIAS2019-21890|https://jira.mos.social/browse/KISEMIAS2019-21890]'));
});
test('same source can be transferred to both destinations without conflating completion keys',()=>{
  assert.notEqual(C.completionKey('source','jira'),C.completionKey('source','redmine'));
  assert.equal(C.destinationOf({stage:'done'}),'redmine');
});
const settings={date:'2026-11-23',localDeadline:'duedate',localPriority:''};
const meta={id:'7',fields:{project:{required:true},issuetype:{required:true},summary:{required:true},description:{schema:{type:'string'}},duedate:{schema:{type:'date'}},reporter:{schema:{type:'user'}}}};
test('KIS payload uses selected type, due date and the logged-in local user',()=>{
  const p=C.localPayload(meta,settings,'description',{name:'denis'},'Summary [21890]');
  assert.equal(p.fields.project.key,'KIS');assert.equal(p.fields.issuetype.id,'7');assert.equal(p.fields.duedate,'2026-11-23');assert.equal(p.fields.reporter.name,'denis');
});
test('local payload uses the resolved requester rather than a hardcoded account',()=>{
  const reporter=C.resolvePerson([{name:'i.petrov',displayName:'Петров Иван'}],'Иван Петров');
  assert.equal(C.localPayload(meta,settings,'description',reporter,'Title').fields.reporter.name,'i.petrov');
});
test('missing required fields or wrong deadline stop before creating an issue',()=>{
  assert.throws(()=>C.localPayload({...meta,fields:{...meta.fields,customfield_9:{name:'Команда',required:true}}},settings,'d',{},'s'),/Команда/);
  assert.throws(()=>C.localPayload(meta,{...settings,localDeadline:'Нет поля'},'d',{},'s'),/Не найдено поле срока/);
});
function localContext(){
  const elements={};
  const ctx=vm.createContext({URL,console,setTimeout,chrome:{storage:{local:{get:()=>new Promise(()=>{})}}},document:{getElementById:id=>elements[id]??(elements[id]={value:'',textContent:''})}});
  for(const file of ['core.js','updates.js','app.js'])vm.runInContext(fs.readFileSync(require.resolve('../'+file),'utf8'),ctx);
  vm.runInContext(`job={source:'https://jira.mos.social/browse/X-1',destination:'jira',stage:'preparing'};save=async()=>{};recordCompletion=async()=>{};blobData=async()=>'';
    uploaded=[];creates=0;uploads=0;loseResponse=true;
    localRequest=async(path,method='GET',body=null,file=null)=>{
      if(path==='/rest/api/2/issue'&&method==='POST'){creates++;return {status:201,data:{key:'KIS-999'}};}
      if(file){uploads++;uploaded.push({filename:file.name,size:10});if(loseResponse){loseResponse=false;throw Error('connection lost');}return {status:200,data:[]};}
      return {status:200,data:{fields:{attachment:uploaded}}};
    };
    files=[{name:'image-1.png',blob:{size:10,type:'image/png'}},{name:'page.mhtml',blob:{size:10,type:'multipart/related'}}];
  `,ctx);return ctx;
}
test('retry after a lost upload response resumes the existing Jira issue and skips the uploaded file',async()=>{
  const ctx=localContext();
  await assert.rejects(vm.runInContext('transferLocal({},files,{payload:{fields:{}},limit:1024})',ctx),/connection lost/);
  assert.equal(vm.runInContext('job.stage',ctx),'uploading');assert.equal(vm.runInContext('job.localKey',ctx),'KIS-999');
  await vm.runInContext('transferLocal({},files)',ctx);
  assert.equal(vm.runInContext('creates',ctx),1);assert.equal(vm.runInContext('uploads',ctx),2);assert.equal(vm.runInContext('job.stage',ctx),'done');
});
test('uncertain creation stays blocked, definitive validation rejection permits retry',async()=>{
  for(const [status,expected] of [[500,'sending'],[400,'preparing']]){
    const ctx=localContext();vm.runInContext(`localRequest=async()=>({status:${status},data:{errorMessages:['failure']}});`,ctx);
    await assert.rejects(vm.runInContext('transferLocal({},[],{payload:{fields:{}},limit:1024})',ctx),/failure/);
    assert.equal(vm.runInContext('job.stage',ctx),expected);assert.equal(vm.runInContext('job.localKey',ctx),undefined);
  }
});
