// Refresh and update orchestration. Loaded in the invisible engine before app.js.
function reportSkippedPages() {
  if(job?.skippedPages?.length)log($('status').textContent+' Предупреждение: не сохранены MHTML-архивы ('+job.skippedPages.length+'): '+job.skippedPages.map(p=>p.url).join('; ')+'. Остальные файлы перенесены.');
}
async function findExisting(s,hint) {
  const number=C.issueIdentity(issue.subject)?.number;if(!number)throw Error('Не найден номер Jira в конце названия.');
  let candidates=[];
  if(s.destination==='jira') {
    let start=0;
    for(let page=0;page<200;page++) {
      const jql='project = KIS AND summary ~ "'+number+'" ORDER BY key ASC';
      const data=localData(await localRequest('/rest/api/2/search?'+new URLSearchParams({jql,startAt:String(start),maxResults:'100',fields:'summary,description'})));
      if(!Array.isArray(data.issues)||!Number.isFinite(data.total))throw Error('Локальная Jira не подтвердила полноту поиска. Новая задача не создаётся.');
      candidates.push(...data.issues.map(i=>({key:i.key,subject:i.fields.summary,description:i.fields.description,url:LOCAL+'/browse/'+i.key})));
      start+=data.issues.length;
      if(start>=data.total)break;
      if(!data.issues.length||page===199)throw Error('Не удалось проверить все результаты Jira. Новая задача не создаётся.');
    }
    if(hint?.result?.startsWith(LOCAL+'/browse/')) {
      const key=new URL(hint.result).pathname.split('/').pop();
      if(/^KIS-\d+$/.test(key)){
        const response=await localRequest('/rest/api/2/issue/'+key+'?fields=summary,description');
        if(response.status===200&&response.data?.fields)candidates.push({key,subject:response.data.fields.summary,description:response.data.fields.description,url:LOCAL+'/browse/'+key});
        else if(response.status!==404)localData(response);
      }
    }
  }else {
    const tab=await tabFor(s.redmine+'/issues',true);
    candidates=await inTab(tab.id,'searchRedmine',[s,number]);
  }
  return C.pickExisting(candidates,issue.subject,issue.url);
}
async function versionFiles(files) {
  const names={};const result=[];
  for(const file of files){
    const bytes=await crypto.subtle.digest('SHA-256',await file.blob.arrayBuffer());
    const hash=[...new Uint8Array(bytes)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const name=C.versionedFileName(file.name,hash);names[file.name]=name;
    result.push({...file,name,hash});
  }
  for(const field of ['description','jiraDescription'])if(typeof issue[field]==='string'){
    // Only attachment image references are renamed; prose and external URLs stay intact.
    issue[field]=issue[field].replace(/!([^!\n]+)!/g,(whole,body)=>{
      for(const [oldName,newName] of Object.entries(names))if(body.includes(oldName))return '!'+body.replace(oldName,newName)+'!';
      return whole;
    });
  }
  for(const url of Object.keys(issue.imageNames))if(names[issue.imageNames[url]])issue.imageNames[url]=names[issue.imageNames[url]];
  return result;
}
async function prepareLocalUpdate(s,key) {
  if(!issue.jiraDescription)throw Error(issue.jiraError||'Прочитайте исходную Jira заново.');
  const meta=localData(await localRequest('/rest/api/2/issue/'+key+'/editmeta'));
  const me=localData(await localRequest('/rest/api/2/myself'));
  const reporter=await localReporter(s.requester,me);
  if(!meta.fields?.reporter&&reporter.name!==me.name)throw Error('Поле постановщика недоступно для изменения в локальной Jira.');
  const payload=C.localUpdatePayload(meta.fields||{},s,issue.jiraDescription,reporter,issue.subject);
  const limit=localData(await localRequest('/rest/api/2/attachment/meta'));
  if(!limit.enabled)throw Error('Вложения локальной Jira отключены.');
  const deadlineKey=Object.keys(payload.fields).find(k=>k===s.localDeadline||meta.fields[k]?.name===s.localDeadline);
  return {payload,limit:limit.uploadLimit,deadlineKey};
}
async function updateRedmine(s,files,target) {
  const encoded=[];
  for(const file of files){if(file.blob.size>50*1024*1024)throw Error('Файл больше 50 МБ: '+file.name);encoded.push({name:file.name,type:file.blob.type,data:await blobData(file.blob)});}
  const tab=await tabFor(target.url,true);
  job.stage='updating';job.result=target.url;job.target=target;await save();
  log('Обновляю существующую задачу Redmine №'+target.id+'…');
  const result=await inTab(tab.id,'updateRedmine',[s,issue,encoded,target]);
  if(!result.ok)throw Error(result.message||'Обновление Redmine не подтверждено. Повторите перенос: новая задача не будет создана.');
  job.stage='done';await save();await recordCompletion();
  log('Задача Redmine №'+target.id+' обновлена. Описание, срок, постановщик и вложения проверены. Статус и исполнитель сохранены.');
}
async function transfer() {
  const s=settings();if(!issue||issue.key!==s.jira.key)throw Error('Сначала прочитайте эту задачу.');
  if(job?.stage==='sending')throw Error('Сначала проверьте результат предыдущего создания в системе назначения.');
  const pending=job&&['uploading','updating'].includes(job.stage);
  if(pending&&(job.source!==issue.url||C.destinationOf(job)!==s.destination))throw Error('Сначала завершите предыдущий перенос в выбранной ранее системе.');
  if(pending&&!job.sourceIssue){job.sourceIssue=structuredClone(issue);if(job.localKey&&!job.mode)job.mode='update';}
  const hint=job?.source===issue.url&&C.destinationOf(job)===s.destination?job:(await API.storage.local.get('completions')).completions?.[C.completionKey(issue.url,s.destination)];
  if(pending&&job.sourceIssue){issue=structuredClone(job.sourceIssue);}
  else{log('Проверяю актуальную постановку в исходной Jira…');await read(true);}
  if(!s.requester)throw Error('Введите имя и фамилию постановщика.');
  const urls=[...new Set([...$('links').querySelectorAll('input:checked')].map(e=>e.value).concat($('extra').value.split(/\r?\n/).filter(s=>s.trim()).map(u=>C.webURL(u))))];
  if(!urls.includes(issue.url))urls.unshift(issue.url);
  const origins=[...new Set([...urls,...issue.images].map(u=>new URL(u).origin+'/*'))];
  if(!await API.permissions.contains({origins}))throw Error('После обновления появились страницы, к которым нет доступа. Проверьте список и нажмите «Перенести» ещё раз для выдачи разрешения.');
  const fingerprint=JSON.stringify({source:issue.url,description:issue.description,updated:issue.updated,images:issue.images,urls,s});
  if(pending&&job.fingerprint!==fingerprint)throw Error('Для продолжения верните прежние дату, настройки и список страниц.');
  let target=pending?(job.target||(job.localKey?{key:job.localKey,url:job.result,subject:issue.subject}:null)):null;
  if(!pending){
    log('Ищу задачу по конечному номеру ['+C.issueIdentity(issue.subject).number+'] в '+(s.destination==='jira'?'локальной Jira':'Redmine')+'…');
    target=await findExisting(s,hint);
    const retry=job?.stage==='preparing'&&job.fingerprint===fingerprint;
    job={id:retry?job.id:crypto.randomUUID(),downloads:retry?job.downloads:[],source:issue.url,destination:s.destination,fingerprint,sourceIssue:structuredClone(issue),stage:'preparing',target,mode:target?'update':'create',result:target?.url,localKey:target?.key};
  }
  await save();await API.storage.local.set({settings:s,extra:$('extra').value});
  let prepared;
  if(s.destination==='jira')prepared=target?await prepareLocalUpdate(s,target.key):await prepareLocal(s);
  const files=await versionFiles(await filesFor(s,urls));
  // Recheck after slow MHTML capture: another transfer could have completed meanwhile.
  if(!target&&!pending){target=await findExisting(s,hint);if(target){job.target=target;job.mode='update';job.result=target.url;job.localKey=target.key;if(s.destination==='jira')prepared=await prepareLocalUpdate(s,target.key);await save();}}
  if(s.destination==='jira'){
    prepared.payload.fields.description=issue.jiraDescription;
    job.localPrepared=prepared;await save();
    await transferLocal(s,files,prepared);reportSkippedPages();return;
  }
  if(target){await updateRedmine(s,files,target);reportSkippedPages();return;}
  await createRedmine(s,files);reportSkippedPages();
}
