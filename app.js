'use strict';
const $ = id => document.getElementById(id);
const C = TransferCore;
const API = globalThis.ExtensionAPI || chrome;
let issue, job, busy = false, runnerReady = false;
const configIds = ['source','date','destination','localType','localPriority','localDeadline','redmine','project','tracker','priority','requester','deadlineLabel'];
const sleep = ms => new Promise(r=>setTimeout(r,ms));
function log(s) { $('status').textContent=s; $('log').textContent += `${new Date().toLocaleTimeString('ru-RU')}  ${s}\n`; }
function showState() {
  $('uncertain').hidden = job?.stage !== 'sending';
  $('result').hidden = !job?.result;
  if(job?.result) $('result').href=job.result;
}
async function save() { await API.storage.local.set({job}); showState(); }
async function resetTransfer() {
  // A failed operation is idle. Never detach a live operation from its job state:
  // its delayed callbacks could otherwise resume uploading after the reset.
  if(busy)throw Error('Перенос ещё выполняется. Кнопка сброса станет доступна после завершения или ошибки.');
  busy=true;
  try{
    const state=await API.storage.local.get(['job','completions']);
    const previous=state.job||job;
    const lastReset={at:new Date().toISOString(),source:previous?.source||null,destination:previous?C.destinationOf(previous):null,result:previous?.result||null,stage:previous?.stage||null};
    const values={job:null,lastReset};
    if(previous?.source&&previous.result){
      // Keep only a lookup hint for an already created task, not a resumable job.
      const completions=state.completions||{};
      completions[C.completionKey(previous.source,C.destinationOf(previous))]={source:previous.source,destination:C.destinationOf(previous),result:previous.result,stage:'reset'};
      values.completions=completions;
    }
    await API.storage.local.set(values);
    job=null;
    $('existing').value='';$('checked').checked=false;
    log('Предыдущий перенос сброшен и больше не будет продолжен. Можно переносить другую задачу. Созданные задачи и файлы сохранены.');
    showState();
    return {ok:true};
  }finally{busy=false;}
}
async function guard(fn) {
  if(busy) return; busy=true;
  document.querySelectorAll('button').forEach(b=>b.disabled=true);
  try { await navigator.locks.request('obltech-transfer',{ifAvailable:true},async lock=>{
    if(!lock) throw Error('Перенос уже работает в другой вкладке утилиты.');
    // Another extension page may have completed a transfer since this page opened.
    job=(await API.storage.local.get('job')).job;
    await fn();
  }); } catch(e) { log(`Остановлено: ${e.message}`); }
  finally { busy=false; document.querySelectorAll('button').forEach(b=>b.disabled=false); showState(); }
}
function settings() {
  const s=Object.fromEntries(configIds.map(id=>[id,$(id).value.trim()]));
  s.destination=s.destination||'redmine';s.localType=s.localType||'Доработка';s.localDeadline=s.localDeadline||'duedate';
  s.jira=C.parseJira(s.source); C.validateDate(s.date);
  s.redmine=C.webURL(s.redmine).replace(/\/$/,'');
  if(s.redmine!=='https://rm.oblteh.ru/redmine') throw Error('Эта версия настроена на https://rm.oblteh.ru/redmine.');
  if(!['redmine','jira'].includes(s.destination))throw Error('Выберите систему назначения.');
  return s;
}
async function tabFor(url,reuseOrigin=false) {
  const tabs=await API.tabs.query({});
  let tab=tabs.find(t=>t.url===url||(reuseOrigin&&t.url?.startsWith(new URL(url).origin+'/')));
  if(!tab) tab=await API.tabs.create({url,active:false});
  for(let i=0;i<120;i++) {
    const t=await API.tabs.get(tab.id);
    if(t.status==='complete') return t;
    await sleep(500);
  }
  throw Error('Страница долго загружается. Проверьте вкладку и повторите.');
}
async function inTab(id,func,args=[]) {
  const r=await API.scripting.executeScript({target:{tabId:id},func,args});
  if(!r[0] || r[0].result===undefined) throw Error('Не удалось прочитать страницу. Проверьте вход.');
  const v=r[0].result;
  if(v?.error) throw Error(v.error);
  return v;
}
// Requests execute in the website origin: browser session cookies stay in the browser.
async function get(url, binary=false) {
  const u=new URL(url); const tab=await tabFor(u.origin + (u.hostname==='rm.oblteh.ru'?'/redmine/issues':u.hostname==='jira.mos.social'?'/browse/'+(issue?.key||C.parseJira($('source').value).key):u.pathname));
  return inTab(tab.id,"fetchSource",[url,binary]);
}
let database;
async function db() {
  if(database) return database;
  database=await new Promise((resolve,reject)=>{const r=indexedDB.open('obltech-transfer',1);r.onupgradeneeded=()=>r.result.createObjectStore('files');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  return database;
}
async function fileStore(key,value) {
  const d=await db();
  return new Promise((resolve,reject)=>{
    const t=d.transaction('files',value===undefined?'readonly':'readwrite');
    const r=value===undefined?t.objectStore('files').get(key):t.objectStore('files').put(value,key);
    let result;r.onsuccess=()=>{result=r.result;};t.oncomplete=()=>resolve(result);t.onerror=()=>reject(t.error);
  });
}
async function download(blob,name) {
  const url=URL.createObjectURL(blob);
  try {
    const id=await API.downloads.download({url,filename:`Jira-Redmine/${issue.key}/${name}`,conflictAction:'overwrite',saveAs:false});
    for(let i=0;i<600;i++) {
      const [d]=await API.downloads.search({id});
      if(d?.state==='complete') return;
      if(d?.state==='interrupted') throw Error('Загрузка прервана: '+(d.error||name));
      await sleep(500);
    }
    throw Error('Не удалось подтвердить сохранение '+name);
  } finally {URL.revokeObjectURL(url);}
}
function convert(html,base,imageNames) {
  const doc=new DOMParser().parseFromString(html,'text/html');
  const warnings=new Set();
  function walk(n,lists='') {
    if(n.nodeType===3) return n.textContent.replace(/\s+/g,' ').replace(/[&<>*_@#|%+~^!\[\]{}]/g,c=>`&#${c.charCodeAt(0)};`);
    if(n.nodeType!==1) return '';
    const tag=n.tagName.toLowerCase();
    if(['script','style','iframe','object'].includes(tag)) {warnings.add('Встроенные объекты не перенесены.');return '';}
    const children=()=>Array.from(n.childNodes).map(x=>walk(x,lists)).join('');
    if(tag==='img') {
      let u; try {u=new URL(n.getAttribute('src'),base).href;}catch{return '';}
      const name=imageNames[u]; if(name===null)return '';
      if(!name) throw Error('Не подготовлено изображение '+u);
      return C.imageMarkup(name);
    }
    if(tag==='a') {
      // Image markup must stay outside Textile's quoted-link label.
      const picture=n.querySelector('img');
      if(picture){let src;try{src=new URL(picture.getAttribute('src'),base).href;}catch{}if(imageNames[src])return children();}
      let url;try{url=new URL(n.getAttribute('href'),base);if(!['http:','https:','mailto:'].includes(url.protocol))return children();}catch{return children();}
      const label=children().trim();return label?`"${label.replace(/"/g,'&quot;')}":${url.href}`:url.href;
    }
    if(tag==='pre') return '\n\n<pre>'+n.textContent.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')+'</pre>\n\n';
    if(tag==='code') return '@'+n.textContent.replace(/@/g,'&#64;')+'@';
    if(tag==='ul'||tag==='ol') return '\n'+Array.from(n.children).map(x=>walk(x,lists+(tag==='ul'?'*':'#'))).join('')+'\n';
    if(tag==='li') return lists+' '+children().trim()+'\n';
    if(tag==='br') return '\n';
    if(tag==='hr') return '\n\n---\n\n';
    if(/^h[1-6]$/.test(tag)) return `\n\nh${tag[1]}. ${children().trim()}\n\n`;
    if(tag==='tr') return '|'+Array.from(n.children).map(c=>(c.tagName==='TH'?'_. ':'')+walk(c,lists).trim().replace(/\n/g,' ')).join('|')+'|\n';
    if(tag==='table') return '\n\n'+children()+'\n\n';
    if(n.hasAttribute('colspan')||n.hasAttribute('rowspan')) warnings.add('Объединённые ячейки таблиц требуют проверки.');
    let s=children();
    const mark={strong:'*',b:'*',em:'_',i:'_',u:'+',s:'-',del:'-',sup:'^',sub:'~'}[tag];
    if(mark&&s.trim()) s=mark+s.trim()+mark;
    const styles=['color','background-color','text-align'].map(k=>[k,n.style.getPropertyValue(k)]).filter(([,v])=>v&&/^[a-z0-9#(),.% -]+$/i.test(v));
    if(styles.length&&s.trim()) s='%{'+styles.map(([k,v])=>k+':'+v).join(';')+'}'+s.trim()+'%';
    if(n.hasAttribute('style')) warnings.add('Цвета и размеры перенесены частично; проверьте предпросмотр Redmine.');
    if(['p','div','blockquote'].includes(tag)) return '\n\n'+(tag==='blockquote'?'bq. ':'')+s.trim()+'\n\n';
    return s;
  }
  return {text:Array.from(doc.body.childNodes).map(n=>walk(n)).join('').replace(/\n{3,}/g,'\n\n').trim(),warnings:[...warnings]};
}
function render() {
  $('preview').hidden=false; $('subject').textContent=issue.subject;
  $('description').textContent=$('destination').value==='jira'?(issue.jiraDescription||'Прочитайте задачу заново для локальной Jira.'):issue.description;
  $('warnings').textContent=[$('destination').value==='jira'?'Для локальной Jira сохраняется исходная Wiki-разметка; изображения прикладываются к новой задаче.':'Форматирование преобразуется в Textile. Точное визуальное совпадение проверяется в Redmine.',...issue.warnings].join(' ');
  $('links').replaceChildren();
  for(const url of issue.links) {
    const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=url;box.checked=true;label.append(box,document.createTextNode(' '+url));$('links').append(label);
  }
}
async function read(preserveSelection=false) {
  if(job?.stage==='sending')throw Error('Сначала проверьте результат предыдущей отправки в Redmine.');
  const previous=preserveSelection&&issue?.links?new Map(issue.links.map(u=>[u,[...$('links').querySelectorAll('input:checked')].some(e=>e.value===u)])):null;
  const s=settings(); await API.storage.local.set({settings:s});
  log('Читаю описание и связанные задачи Jira…');
  issue={key:s.jira.key};
  const r=await get(`${s.jira.origin}/rest/api/2/issue/${s.jira.key}?expand=renderedFields&fields=summary,description,issuelinks,attachment,updated`);
  let data;try {data=JSON.parse(r.text);}catch{throw Error('Jira вернула страницу вместо данных. Войдите в Jira и повторите.');}
  if(!data.fields?.summary) throw Error('Не удалось прочитать название Jira.');
  const html=data.renderedFields?.description;
  if(data.fields.description && typeof html!=='string') throw Error('Jira не вернула описание в HTML. Нужна адаптация под вашу версию Jira.');
  const d=new DOMParser().parseFromString(html||'','text/html');
  const images=[],imageNames={},originals=new Map();
  for(const img of d.images) {
    const src=C.webURL(img.getAttribute('src'),s.jira.url);
    const asset=C.imageAsset({src,href:img.closest('a')?.getAttribute('href')||'',width:img.getAttribute('width'),height:img.getAttribute('height')},data.fields.attachment,images.length+1,s.jira.url);
    if(!asset){imageNames[src]=null;continue;}
    if(!originals.has(asset.url)){originals.set(asset.url,asset.name);images.push(asset.url);}
    imageNames[src]=originals.get(asset.url);imageNames[asset.url]=originals.get(asset.url);
  }
  const links=new Set([s.jira.url]);
  for(const a of d.querySelectorAll('a[href]')) {
    try {const u=C.webURL(a.getAttribute('href'),s.jira.url);if(!images.includes(u)&&!u.includes('/secure/attachment/')) links.add(u);}catch{}
  }
  for(const relation of data.fields.issuelinks||[]) {
    const key=(relation.outwardIssue||relation.inwardIssue)?.key;if(key) links.add(`${s.jira.origin}/browse/${key}`);
  }
  const converted=convert(html||'',s.jira.url,imageNames);
  const aliases={...imageNames};
  for(const a of data.fields.attachment||[])if(originals.has(a.content))aliases[a.filename]=originals.get(a.content);
  let jiraDescription,jiraError;
  try{jiraDescription=C.jiraDescription(data.fields.description||'',aliases,data.fields.attachment||[],s.jira.url);}catch(e){jiraError=e.message;}
  issue={revision:Date.now(),updated:data.fields.updated,imageVersion:2,key:s.jira.key,url:s.jira.url,subject:`${data.fields.summary} [${s.jira.number}]`,html:html||'',images,imageNames,links:[...links],warnings:converted.warnings,jiraDescription,jiraError,description:converted.text+'\n\nСсылка на Jira: '+s.jira.url};
  await API.storage.local.set({issue});
  render();if(previous)for(const box of $('links').querySelectorAll('input'))if(previous.has(box.value))box.checked=previous.get(box.value);
  log('Описание получено. Проверьте список страниц и запустите перенос.');
}
async function archive(url,name) {
  const tab=await tabFor(url);
  const state=await inTab(tab.id,"inspectArchive");
  if(new URL(state.url).origin!==new URL(url).origin) throw Error('Страница перенаправлена. Завершите вход и повторите: '+url);
  if(/login|sign in|вход в систему|авторизац/i.test(state.title))throw Error('Вместо нужной страницы открыт вход: '+url);
  const broken=C.failedContentImages(state.images);
  if(broken.length) throw Error(`В описании не загружены изображения (${broken.length}). Откройте страницу, дождитесь загрузки и повторите: ${url}. Изображения: ${broken.map(i=>i.url).join(', ')}`);
  if(!state.contentFound) log('Не удалось определить область описания; MHTML будет сохранён без проверки изображений: '+url);
  await sleep(1500);
  const blob=await API.pageCapture.saveAsMHTML({tabId:tab.id});
  if(!blob?.size) throw Error('Не удалось сохранить MHTML: '+url);
  return {name,blob,url};
}
async function filesFor(s,urls) {
  const files=[];
  job.skippedPages=[];
  await save();
  for(const [i,url] of urls.entries()) {
    const name=`page-${String(i+1).padStart(2,'0')}-${C.safeName(new URL(url).pathname.split('/').filter(Boolean).pop()||'index')}.mhtml`;
    const key=job.id+':page:'+url;
    let file=await fileStore(key);
    if(!file){
      log('Сохраняю страницу: '+url);
      try{file=await archive(url,name);}catch(error){
        const reason=C.unavailableArchiveReason(error);
        if(!reason)throw error;
        job.skippedPages.push({url,reason,detail:String(error.message||error),at:new Date().toISOString()});
        await save();
        log('Пропускаю MHTML недоступной страницы: '+url+'. '+reason+' Продолжаю перенос.');
        continue;
      }
      await fileStore(key,file);
    }
    // Download completion, rather than capture, is checkpointed separately.
    if(!job.downloads.includes(key)){await download(file.blob,file.name);job.downloads.push(key);await save();}
    files.push(file);
  }
  for(const url of issue.images) {
    const key=job.id+':image:'+url;let file=await fileStore(key);
    if(!file){log('Загружаю изображение…');const r=await get(url,true);if(!r.type.startsWith('image/'))throw Error('Получен файл, который не является изображением: '+url);file={name:issue.imageNames[url],blob:await (await fetch(r.data)).blob(),url};await fileStore(key,file);}
    if(!job.downloads.includes(key)){await download(file.blob,file.name);job.downloads.push(key);await save();}files.push(file);
  }
  return files;
}
async function blobData(blob) {return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(blob);});}
const LOCAL='http://jira.oblteh:8080';
async function localRequest(path,method='GET',body=null,file=null) {
  if(!path.startsWith('/rest/api/2/'))throw Error('Недопустимый путь локальной Jira.');
  const tab=await tabFor(LOCAL+'/projects/KIS/issues',true);
  const result=await inTab(tab.id,"localRequest",[LOCAL+path,method,body,file]);
  return result;
}
function localData(response) {
  if(response.status<200||response.status>=300||!response.data){
    const details=response.data?[...(response.data.errorMessages||[]),...Object.entries(response.data.errors||{}).map(([k,v])=>k+': '+v)].join('; '):'Проверьте вход и доступ к REST API.';
    throw Error('Локальная Jira: HTTP '+response.status+'. '+details);
  }
  return response.data;
}
async function localMeta() {
  return localData(await localRequest('/rest/api/2/issue/createmeta?projectKeys=KIS&expand=projects.issuetypes.fields'));
}
async function localReporter(wanted,me) {
  if(C.personMatches(me.displayName,wanted)||me.name?.toLowerCase()===wanted.trim().toLowerCase())return me;
  const users=new Map();
  for(const query of [wanted,...wanted.trim().split(/\s+/).reverse()]){
    const found=localData(await localRequest('/rest/api/2/user/search?username='+encodeURIComponent(query)+'&includeActive=true&includeInactive=false&maxResults=1000'));
    if(!Array.isArray(found))throw Error('Локальная Jira не вернула список пользователей для постановщика.');
    for(const user of found)users.set(user.name||user.key,user);
  }
  return C.resolvePerson([...users.values()],wanted);
}
async function prepareLocal(s) {
  if(!issue.jiraDescription)throw Error(issue.jiraError||'Прочитайте задачу заново для подготовки описания локальной Jira.');
  const metadata=await localMeta();
  const project=metadata.projects?.find(p=>p.key==='KIS');
  const matches=(project?.issuetypes||[]).filter(t=>t.name===s.localType||t.id===s.localType);
  if(matches.length!==1)throw Error('Не найден тип «'+s.localType+'» в KIS. Доступны: '+(project?.issuetypes||[]).map(t=>t.name).join('; '));
  const me=localData(await localRequest('/rest/api/2/myself'));
  const reporter=await localReporter(s.requester,me);
  if(!reporter.name)throw Error('Локальная Jira не вернула логин выбранного постановщика. Нужна проверка формата пользователя.');
  if(!matches[0].fields?.reporter&&reporter.name!==me.name)throw Error('В проекте KIS недоступно изменение постановщика (репортера). Введите имя пользователя, под которым выполнен вход, или проверьте права.');
  const limits=localData(await localRequest('/rest/api/2/attachment/meta'));
  if(!limits.enabled)throw Error('В локальной Jira отключены вложения.');
  const payload=C.localPayload(matches[0],s,issue.jiraDescription,reporter,issue.subject);
  const deadlineKey=Object.keys(payload.fields).find(k=>k===s.localDeadline||matches[0].fields?.[k]?.name===s.localDeadline);
  return {payload,limit:limits.uploadLimit,deadlineKey};
}
async function recordCompletion() {
  const state=await API.storage.local.get('completions');const completions=state.completions||{};
  completions[C.completionKey(job.source,C.destinationOf(job))]={...job,downloads:[],fingerprint:null};
  await API.storage.local.set({completions});
}
async function transferLocal(s,files,prepared) {
  if(prepared?.limit)for(const f of files)if(f.blob.size>prepared.limit)throw Error('Файл превышает лимит локальной Jira: '+f.name);
  if(job.mode==='update'&&prepared){job.localPrepared=prepared;job.expectedDate={field:prepared.deadlineKey,value:prepared.payload.fields[prepared.deadlineKey]};job.stage='uploading';await save();}
  if(!job.localKey) {
    for(const f of files)if(prepared.limit&&f.blob.size>prepared.limit)throw Error('Файл превышает лимит локальной Jira: '+f.name);
    job.stage='sending';job.destination='jira';job.localSettings=s;job.expectedDate=prepared.deadlineKey?{field:prepared.deadlineKey,value:prepared.payload.fields[prepared.deadlineKey]}:null;await save();log('Создаю задачу в локальной Jira, проект KIS…');
    const response=await localRequest('/rest/api/2/issue','POST',prepared.payload);
    if(response.status>=400&&response.status<500&&response.status!==408){job.stage='preparing';await save();}
    const created=localData(response);
    if(!/^KIS-\d+$/.test(created.key||''))throw Error('Номер созданной задачи не получен. Проверьте локальную Jira перед повторной отправкой.');
    job.localKey=created.key;job.result=LOCAL+'/browse/'+created.key;job.stage='uploading';await save();
  }
  const key=job.localKey;
  for(const f of files) {
    const current=localData(await localRequest('/rest/api/2/issue/'+key+'?fields=attachment'));
    if((current.fields?.attachment||[]).some(a=>a.filename===f.name&&Number(a.size)===f.blob.size))continue;
    log('Локальная Jira '+key+': прикладываю '+f.name+'…');
    localData(await localRequest('/rest/api/2/issue/'+key+'/attachments','POST',null,{name:f.name,type:f.blob.type,data:await blobData(f.blob)}));
  }
  if(job.mode==='update') {
    job.stage='updating';await save();log('Обновляю описание и поля локальной Jira '+key+'…');
    const response=await localRequest('/rest/api/2/issue/'+key,'PUT',job.localPrepared.payload);
    if(response.status!==204)localData(response);
  }
  const verified=localData(await localRequest('/rest/api/2/issue/'+key+'?fields=attachment,description,'+(job.expectedDate?.field||'duedate')));
  const missing=files.filter(f=>!(verified.fields?.attachment||[]).some(a=>a.filename===f.name&&Number(a.size)===f.blob.size));
  if(missing.length)throw Error('Задача '+key+' создана, но вложения пока не подтверждены: '+missing.map(f=>f.name).join(', ')+'. Повторите перенос для продолжения загрузки.');
  if(job.mode==='update'&&verified.fields?.description!==job.localPrepared.payload.fields.description)throw Error('Обновление описания '+key+' не подтверждено. Повторите перенос: новая задача не создаётся.');
  job.stage='done';await save();await recordCompletion();
  const actual=job.expectedDate?verified.fields?.[job.expectedDate.field]:null;
  const dateOK=!job.expectedDate||actual===job.expectedDate.value||(actual&&job.expectedDate.value.includes('T')&&new Date(actual).getTime()===new Date(job.expectedDate.value).getTime());
  log(dateOK?'Задача '+key+(job.mode==='update'?' обновлена':' создана')+' в локальной Jira. Все вложения и дата подтверждены. Проверьте описание и изображения по ссылке.':'Задача '+key+' сохранена со всеми вложениями, но дата не подтверждена. Проверьте поле срока в задаче.');
}
async function redmineOptions(tabId,id) {
  return inTab(tabId,"redmineOptions",[id]);
}
async function selectRedmine(tabId,id,wanted) {
  const option=C.chooseOption(await redmineOptions(tabId,id),wanted);
  await inTab(tabId,"selectRedmine",[id,option.value]);
  return option.value;
}
async function prepareRedmine(s,files) {
  const tab=await tabFor(s.redmine+'/issues/new');
  await API.tabs.update(tab.id,{active:true});
  // Select project first: Redmine replaces fields after project/tracker changes.
  s.projectValue=await selectRedmine(tab.id,'issue_project_id',s.project);
  await sleep(2500);
  s.trackerValue=await selectRedmine(tab.id,'issue_tracker_id',s.tracker);
  await sleep(2500);
  s.requesterValue=C.resolvePerson(await inTab(tab.id,'redmineRequesters'),s.requester).value;
  const encoded=[];
  for(const f of files){if(f.blob.size>50*1024*1024)throw Error('Файл больше 50 МБ: '+f.name);encoded.push({name:f.name,data:await blobData(f.blob),type:f.blob.type});}
  await inTab(tab.id,"fillRedmine",[s,issue,encoded]);
  return tab;
}
async function createRedmine(s,files) {
  log('Заполняю новую задачу Redmine и прикладываю файлы…');
  const tab=await prepareRedmine(s,files);
  job.stage='sending';job.tabId=tab.id;await save();
  log('Отправляю задачу. Не запускайте повторную отправку до проверки результата…');
  await inTab(tab.id,"submitRedmine");
  await sleep(1500);
  for(let i=0;i<120;i++) {
    const t=await API.tabs.get(tab.id);
    if(t.status==='complete') {
      const m=t.url?.match(/^https:\/\/rm\.oblteh\.ru\/redmine\/issues\/\d+(?:[?#].*)?$/);
      if(m) {
        job.result=t.url;job.stage='done';await save();await recordCompletion();
        const verification=await inTab(tab.id,"verifyRedmine",[files.map(f=>f.name),issue.images.map(url=>issue.imageNames[url])]);
        if(verification.missing.length)log('Задача создана, но не все вложения найдены: '+verification.missing.join(', ')+'. Проверьте задачу вручную; повторное создание заблокировано.');
        else if(verification.notRendered.length)log('Задача создана с вложениями, но отображение картинок в описании не подтверждено: '+verification.notRendered.join(', ')+'. Проверьте описание; повторное создание заблокировано.');
        else log('Задача создана; вложения и изображения в описании проверены. Проверьте оформление и дату в Redmine.');
        return;
      }
      const errors=await inTab(tab.id,"redmineErrors");
      if(errors){job.stage='preparing';await save();throw Error('Redmine отклонил создание: '+errors);}
    }
    await sleep(500);
  }
  throw Error('Подтверждение не получено. Проверьте вкладку Redmine; повторная отправка заблокирована до проверки.');
}
$('read').onclick=()=>guard(read);
$('destination').onchange=()=>{if(issue?.subject)render();showState();};
$('loadLocal').onclick=()=>guard(async()=>{
  const metadata=await localMeta(),project=metadata.projects?.find(p=>p.key==='KIS');
  $('localTypes').replaceChildren();
  for(const type of project?.issuetypes||[]){const e=document.createElement('option');e.value=type.name;$('localTypes').append(e);}
  const type=project?.issuetypes?.find(t=>t.name===$('localType').value);
  log('Типы задач KIS: '+(project?.issuetypes||[]).map(t=>t.name).join('; ')+'. Поля выбранного типа: '+Object.entries(type?.fields||{}).map(([k,v])=>v.name+' ('+k+')'+(v.required?' — обязательное':'')).join('; '));
});
$('loadProjects').onclick=()=>guard(async()=>{
  const tab=await tabFor('https://rm.oblteh.ru/redmine/issues/new');
  const options=(await redmineOptions(tab.id,'issue_project_id')).filter(o=>o.value&&!o.disabled);
  $('projects').replaceChildren();
  for(const o of options){const e=document.createElement('option');e.value=o.label.trim();$('projects').append(e);}
  log('Названия проектов загружены. Выберите проект в настройках: '+options.map(o=>o.label.trim()).join('; '));
});
$('run').onclick=()=>guard(transfer);
$('reset').onclick=()=>resetTransfer().catch(e=>log('Сброс не выполнен: '+e.message));
$('unlock').onclick=()=>guard(async()=>{if(!$('checked').checked)throw Error('Подтвердите, что проверили отсутствие созданной задачи.');job.stage='preparing';await save();log('Можно повторить перенос.');});
$('markDone').onclick=()=>guard(async()=>{
  const u=C.webURL($('existing').value);
  if(C.destinationOf(job)==='jira'){
    const parsed=new URL(u);const key=parsed.pathname.match(/\/(?:browse|issues)\/(KIS-\d+)$/)?.[1];
    if(parsed.origin!==LOCAL||!key)throw Error('Укажите ссылку на созданную задачу локальной Jira KIS.');
    const actual=localData(await localRequest('/rest/api/2/issue/'+key+'?fields=description,summary'));
    if(!actual.fields?.description?.includes(job.source))throw Error('В задаче не найдена ссылка на исходную Jira. Проверьте выбранную задачу.');
    job.localKey=key;job.result=LOCAL+'/browse/'+key;job.stage='uploading';await save();log('Задача найдена. Повторите перенос, чтобы продолжить загрузку файлов.');
  }else{
    const parsed=new URL(u);if(parsed.origin!=='https://rm.oblteh.ru'||!/^\/redmine\/issues\/\d+$/.test(parsed.pathname))throw Error('Укажите ссылку на созданную задачу Redmine.');job.result=u;job.stage='done';await save();await recordCompletion();log('Ссылка сохранена.');
  }
});
(async()=>{
  const state=await API.storage.local.get(['settings','issue','job','extra','lastReset']);
  for(const id of configIds)if(state.settings?.[id])$(id).value=state.settings[id];
  issue=state.issue;job=state.job;if(issue)render();if(state.extra)$('extra').value=state.extra;showState();
  if(job?.stage==='sending')log('Предыдущая отправка не подтверждена. Проверьте систему назначения.');
  else if(!job&&state.lastReset)log('Предыдущий перенос сброшен. Можно начать новый перенос.');
  runnerReady=true;
})().catch(e=>log(e.message));

function runnerSnapshot() {
  return {ready:runnerReady,busy,settings:Object.fromEntries(configIds.map(id=>[id,$(id).value])),
    issue:issue?.subject?{key:issue.key,url:issue.url,subject:issue.subject,images:issue.images,links:issue.links,revision:issue.revision||issue.description}:null,
    selected:[...$('links').querySelectorAll('input:checked')].map(e=>e.value),extra:$('extra').value,
    fullSettings:Object.fromEntries(configIds.map(id=>[id,$(id).value])),description:issue?($('destination').value==='jira'?issue.jiraDescription:issue.description):'',warnings:$('warnings').textContent,
    projects:[...$('projects').children].map(e=>e.value),localTypes:[...$('localTypes').children].map(e=>e.value),
    skippedPages:job?.skippedPages||[],status:$('status').textContent,log:$('log').textContent,stage:job?.stage,jobDestination:C.destinationOf(job),result:job?.source===issue?.url?job?.result:null};
}
if(API.runtime?.onMessage)API.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message?.target!=='runner'||sender.id!==API.runtime.id)return;
  (async()=>{
    if(!runnerReady)return {ready:false};
    if(message.command==='snapshot')return runnerSnapshot();
    if(message.command==='reset')return resetTransfer();
    if(!['read','transfer','loadProjects','loadLocal','unlock','markDone','configure'].includes(message.command))throw Error('Неизвестная команда.');
    if(busy)throw Error('Процесс уже работает.');
    const input=message.data||{};
    for(const id of [...configIds,'existing'])if(typeof input[id]==='string')$(id).value=input[id];
    if(typeof input.checked==='boolean')$('checked').checked=input.checked;
    if(message.command==='configure'){await API.storage.local.set({settings:Object.fromEntries(configIds.map(id=>[id,$(id).value]))});if(issue?.subject)render();return {accepted:true};}
    if(message.command==='transfer') {
      if(typeof input.extra==='string')$('extra').value=input.extra;
      if(Array.isArray(input.selected))for(const e of $('links').querySelectorAll('input'))e.checked=input.selected.includes(e.value);
    }
    // Acknowledge immediately: work must not depend on the popup message staying open.
    if(message.command==='read'||message.command==='transfer')void guard(message.command==='read'?read:transfer);
    else $(message.command).onclick();
    return {accepted:true};
  })().then(value=>{if(value!==null)respond(value);},e=>respond({error:e.message}));
  return true;
});
