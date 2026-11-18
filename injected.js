// Static functions executed in website tabs; no extension state is captured.
globalThis.Injected={
"searchRedmine":async (s,number)=>{
  try{
    const parse=async url=>{
      const response=await fetch(url,{credentials:'include'});if(!response.ok)throw Error('Поиск Redmine: HTTP '+response.status);
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');
      if(doc.querySelector('input[type=password]'))throw Error('Войдите в Redmine и повторите перенос.');
      const error=doc.querySelector('#errorExplanation, .flash.error');if(error)throw Error(error.textContent.trim());return doc;
    };
    const form=await parse(s.redmine+'/issues/new');
    const norm=t=>t.normalize('NFKC').replace(/^[\s»›>\-–—]+/,'').replace(/\s+/g,' ').trim().toLocaleLowerCase('ru');
    const projects=[...form.querySelectorAll('#issue_project_id option')].filter(o=>o.value&&!o.disabled&&norm(o.textContent)===norm(s.project));
    if(projects.length!==1)throw Error('Не удалось однозначно определить проект Redmine для поиска. Проверьте название проекта.');
    const query=new URLSearchParams({set_filter:'1',per_page:'100'});
    for(const [field,op,value]of [['status_id','*',null],['project_id','=',projects[0].value],['subject','~',number]]){
      query.append('f[]',field);query.append('op['+field+']',op);if(value!==null)query.append('v['+field+'][]',value);
    }
    query.append('c[]','subject');
    let url=s.redmine+'/issues?'+query;const seen=new Set(),items=[];
    for(let page=0;page<200;page++){
      if(seen.has(url))throw Error('Зациклена навигация поиска Redmine.');seen.add(url);
      const doc=await parse(url);
      if(!doc.querySelector('table.issues, .nodata'))throw Error('Не удалось прочитать результаты поиска Redmine. Новая задача не создаётся.');
      for(const row of doc.querySelectorAll('tr.issue')){
        const id=row.id.match(/^issue-(\d+)$/)?.[1];if(!id)throw Error('Не распознан номер задачи Redmine.');
        const a=[...row.querySelectorAll('td.subject a')].find(a=>new URL(a.getAttribute('href'),s.redmine+'/').pathname.endsWith('/issues/'+id));
        if(!a)throw Error('В результатах Redmine нет названия задачи '+id);
        items.push({id,subject:a.textContent.trim(),url:s.redmine+'/issues/'+id});
      }
      const next=doc.querySelector('.pagination a[rel=next], .pagination a.next, .pagination .next a');
      if(!next)return items;
      const target=new URL(next.getAttribute('href'),url);
      if(target.origin!==new URL(s.redmine).origin||target.pathname!==new URL(s.redmine+'/issues').pathname)throw Error('Неожиданная ссылка следующей страницы Redmine.');
      url=target.href;
    }
    throw Error('Поиск Redmine слишком большой и не завершён. Новая задача не создаётся.');
  }catch(e){return {error:e.message};}
},
"updateRedmine":async (s,issue,files,target)=>{
  try{
    const normal=s=>String(s||'').replace(/\r\n/g,'\n').trim();
    const normLabel=t=>t.replace(/\*/g,'').replace(/\s+/g,' ').trim();
    const load=async()=>{
      const response=await fetch(target.url+'/edit',{credentials:'include'});if(!response.ok)throw Error('Не удалось открыть редактирование Redmine: HTTP '+response.status);
      const doc=new DOMParser().parseFromString(await response.text(),'text/html');
      const form=doc.querySelector('#issue_subject')?.form;
      if(!form||!doc.querySelector('#issue_description'))throw Error('Нет прав на редактирование задачи Redmine или нужен вход.');
      if(new URL(form.action,target.url).origin!==new URL(s.redmine).origin)throw Error('Неожиданный адрес формы Redmine.');
      return {doc,form};
    };
    const attachedNames=async doc=>{
      const names=[...doc.querySelectorAll('#existing-attachments input.filename')].map(e=>e.value);
      const response=await fetch(target.url,{credentials:'include'});if(!response.ok)throw Error('Не удалось проверить вложения Redmine: HTTP '+response.status);
      const show=new DOMParser().parseFromString(await response.text(),'text/html');
      if(show.querySelector('input[type=password]'))throw Error('Нужен вход в Redmine для проверки вложений.');
      for(const a of [...doc.querySelectorAll('a[href*="/attachments/"]'),...show.querySelectorAll('a[href*="/attachments/"]')]){
        try{names.push(decodeURIComponent(new URL(a.getAttribute('href'),target.url).pathname).split('/').pop());}catch{}
      }
      return names;
    };
    const {doc,form}=await load();
    const currentSubject=normal(doc.querySelector('#issue_subject').value);
    const number=s=>{const m=normal(s).match(/(?:\[(\d{5})\]|\s(\d{5}))$/);return m&&(m[1]||m[2]);};
    if(!number(currentSubject)||number(currentSubject)!==number(issue.subject))throw Error('Номер Jira в найденной задаче изменился. Обновление остановлено.');
    const old=doc.querySelector('#issue_description').value;
    const sources=[...old.matchAll(/(?:Ссылка на Jira|Первоисточник):\s*(https:\/\/jira\.mos\.social\/browse\/[A-Z][A-Z0-9_]*-\d+)/gi)].map(m=>m[1]);
    if(sources.length&&!sources.includes(issue.url))throw Error('В найденной задаче указан другой первоисточник Jira.');
    const labels=[...form.querySelectorAll('label')];
    const field=name=>{const label=labels.find(l=>normLabel(l.textContent)===name);const e=label&&(doc.getElementById(label.htmlFor)||label.querySelector('input,select'));if(!e?.name||e.disabled)throw Error('Поле «'+name+'» недоступно для обновления.');return e;};
    const deadline=field(s.deadlineLabel),requester=field('Постановщик задачи');
    if(!deadline.name.startsWith('issue[custom_field_values]'))throw Error('Не распознано дополнительное поле срока Redmine.');
    const tokens=s=>s.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').trim().split(/\s+/).sort();
    const wanted=tokens(s.requester);
    const people=[...requester.options].filter(o=>o.value&&!o.disabled&&(o.value===s.requester||(()=>{const left=tokens(normLabel(o.textContent));return wanted.length>=2&&left.length<=3&&wanted.every(t=>{const i=left.indexOf(t);if(i<0)return false;left.splice(i,1);return true;});})()));
    if(people.length!==1)throw Error('Постановщик не найден однозначно в задаче Redmine. Проверьте имя.');
    const payload=new FormData();
    for(const name of ['authenticity_token','utf8','issue[lock_version]']){
      const e=[...form.elements].find(e=>e.name===name);if(e)payload.set(name,e.value);
    }
    if(!payload.has('authenticity_token')||!payload.has('issue[lock_version]'))throw Error('В форме Redmine нет токена или версии для безопасного обновления.');
    payload.set('_method','put');payload.set('issue[subject]',issue.subject);payload.set('issue[description]',issue.description);
    payload.set(deadline.name,s.date);payload.set(requester.name,people[0].value);
    const attached=await attachedNames(doc);
    let index=0;
    for(const file of files)if(!attached.includes(file.name)){
      payload.append('attachments['+(index++)+'][file]',new File([await(await fetch(file.data)).blob()],file.name,{type:file.type}));
    }
    const response=await fetch(target.url,{method:'POST',credentials:'include',body:payload});
    const result=new DOMParser().parseFromString(await response.text(),'text/html');
    const error=result.querySelector('#errorExplanation, .flash.error');
    if(!response.ok||error)throw Error(error?.textContent.trim()||'Redmine: HTTP '+response.status);
    const checked=await load();
    if(normal(checked.doc.querySelector('#issue_description').value)!==normal(issue.description)||normal(checked.doc.querySelector('#issue_subject').value)!==normal(issue.subject))throw Error('Redmine не подтвердил обновление описания. Повторите перенос в ту же задачу.');
    const date=checked.doc.getElementById(deadline.id),person=checked.doc.getElementById(requester.id);
    if(date?.value!==s.date||person?.value!==people[0].value)throw Error('Не подтверждены срок или постановщик после обновления Redmine.');
    const finalFiles=await attachedNames(checked.doc);
    const missing=files.filter(f=>!finalFiles.includes(f.name));
    if(missing.length)throw Error('Не подтверждены вложения Redmine: '+missing.map(f=>f.name).join(', '));
    return {ok:true};
  }catch(e){return {error:e.message};}
},
"fetchSource":async (url,binary)=>{
    try {
      if(location.origin!==new URL(url).origin) throw Error('Нужен вход в систему. Войдите во вкладке и повторите запуск.');
      const r=await fetch(url,{credentials:'include'});
      if(!r.ok) throw Error(`Не удалось получить ${url}: HTTP ${r.status}. Проверьте вход и права.`);
      const type=r.headers.get('content-type')||'';
      if(binary) {
        if(type.includes('text/html')) throw Error('Вместо изображения получена страница входа: '+url);
        const blob=await r.blob();
        const data=await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve(f.result);f.onerror=reject;f.readAsDataURL(blob);});
        return {data,type,size:blob.size};
      }
      return {text:await r.text(),type,url:r.url};
    } catch(e) {return {error:e.message};}
  },
"inspectArchive":async ()=>{
    if(document.querySelector('input[type=password]') || /\/(login|signin)([/?]|$)/i.test(location.href)) return {error:'Войдите на открытой странице, затем повторите перенос.'};
    const h=Math.min(document.documentElement.scrollHeight,60000);
    for(let y=0;y<h;y+=800){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,120));}
    window.scrollTo(0,0);
    // Inspect the issue description, not avatars, comments or navigation images.
    // Confluence and generic documentation use their own content containers.
    const root=location.hostname==='jira.mos.social'
      ?document.querySelector('#description-val')
      :document.querySelector('#main-content .wiki-content, #main-content, .wiki-content, article, main');
    const images=root?[...root.querySelectorAll('img')]:[];
    await Promise.race([Promise.all(images.map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,15000))]);
    return {url:location.href,title:document.title,images:images.map(i=>({
      url:i.currentSrc||i.src||i.getAttribute('data-src')||'',
      complete:i.complete,naturalWidth:i.naturalWidth
    })),contentFound:!!root};
  },
"localRequest":async (url,method,body,file)=>{
    try {
      if(location.origin!=='http://jira.oblteh:8080'||document.querySelector('input[type=password]'))throw Error('Войдите в локальную Jira и повторите запуск.');
      const headers={'Accept':'application/json','X-Atlassian-Token':'no-check'};
      let payload;
      if(file){payload=new FormData();payload.append('file',new File([await (await fetch(file.data)).blob()],file.name,{type:file.type}));}
      else if(body){headers['Content-Type']='application/json';payload=JSON.stringify(body);}
      const response=await fetch(url,{method,headers,body:payload,credentials:'include'});
      const text=await response.text();let data;try{data=JSON.parse(text);}catch{}
      return {status:response.status,data,text:data?null:text.slice(0,300)};
    }catch(e){return {error:e.message};}
  },
"redmineOptions":(id)=>{
    const e=document.getElementById(id);
    if(!e)return {error:'Поле '+id+' не найдено. Проверьте вход в Redmine и форму новой задачи.'};
    return [...e.options].map(o=>({value:o.value,label:o.textContent,disabled:o.disabled}));
  },
"selectRedmine":(id,value)=>{
    const e=document.getElementById(id);
    if(!e||![...e.options].some(o=>o.value===value))return {error:'Список полей Redmine изменился. Повторите перенос.'};
    if(e.value!==value){e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}
    return true;
  },
"fillRedmine":async (s,issue,files)=>{
    try {
      const normalize=t=>t.replace(/\*/g,'').replace(/\s+/g,' ').trim();
      const form=document.querySelector('#issue_subject')?.form;if(!form)throw Error('Форма создания задачи не найдена.');
      if(!form.enctype.includes('multipart'))throw Error('Форма не поддерживает загрузку файлов.');
      if(form.method.toLowerCase()!=='post'||!new URL(form.action).pathname.endsWith('/issues'))throw Error('Открыта не форма новой задачи.');
      const select=(id,text)=>{const e=document.getElementById(id),o=[...(e?.options||[])].find(o=>normalize(o.textContent)===text);if(!o)throw Error('Нет значения «'+text+'» в '+id);e.value=o.value;};
      if(document.getElementById('issue_project_id')?.value!==s.projectValue||document.getElementById('issue_tracker_id')?.value!==s.trackerValue)throw Error('Проект или трекер изменился после загрузки формы. Повторите перенос.');
      select('issue_status_id','Новая');select('issue_priority_id',s.priority);
      const labels=[...form.querySelectorAll('label')];
      const field=title=>{const l=labels.find(l=>normalize(l.textContent)===title);const e=l&&(document.getElementById(l.htmlFor)||l.querySelector('input,select'));if(!e||e.disabled)throw Error('Не найдено доступное поле «'+title+'».');return e;};
      const deadline=field(s.deadlineLabel);
      if(!deadline.name.startsWith('issue[custom_field_values]'))throw Error('«Выполнить до» не является ожидаемым дополнительным полем. Нужна проверка формы.');
      deadline.value=s.date;
      const requester=field('Постановщик задачи');
      if(requester.tagName!=='SELECT')throw Error('Поле постановщика требует адаптации.');
      const option=[...requester.options].find(o=>o.value===s.requesterValue&&!o.disabled);if(!option)throw Error('Не найден постановщик '+s.requester);requester.value=option.value;
      document.getElementById('issue_subject').value=issue.subject;
      document.getElementById('issue_description').value=issue.description;
      form.querySelectorAll('[data-obltech-file]').forEach(e=>e.remove());
      if(form.querySelector('input[name$="[token]"]'))throw Error('В форме уже есть загруженные вложения. Обновите вкладку новой задачи и повторите.');
      form.querySelectorAll('input[type=file]').forEach(e=>e.disabled=true);
      for(let i=0;i<files.length;i++) {
        const f=files[i],blob=await (await fetch(f.data)).blob();
        const input=document.createElement('input');input.type='file';input.name=`attachments[${i}][file]`;input.dataset.obltechFile='1';input.hidden=true;
        const dt=new DataTransfer();dt.items.add(new File([blob],f.name,{type:f.type}));input.files=dt.files;form.append(input);
      }
      if(!form.checkValidity()) {form.reportValidity();throw Error('Заполните обязательные поля Redmine во вкладке и повторите.');}
      return true;
    }catch(e){return {error:e.message};}
  },
"submitRedmine":()=>{
    const form=document.getElementById('issue_subject')?.form;
    if(!form)return {error:'Форма исчезла перед отправкой. Проверьте вкладку.'};
    setTimeout(()=>HTMLFormElement.prototype.submit.call(form),50);return true;
  },
"verifyRedmine":async (names,imageNames)=>{
          const links=[...document.querySelectorAll('a[href]')].map(a=>{let href=a.href;try{href=decodeURIComponent(href);}catch{}return href+' '+a.textContent;});
          const images=[...document.querySelectorAll('.description img')];
          await Promise.race([Promise.all(images.map(i=>i.decode().catch(()=>{}))),new Promise(r=>setTimeout(r,10000))]);
          const notRendered=imageNames.filter(name=>!images.some(i=>{let src=i.src;try{src=decodeURIComponent(src);}catch{}return src.includes(name)&&i.complete&&i.naturalWidth>0;}));
          return {missing:names.filter(name=>!links.some(text=>text.includes(name))),notRendered};
        },
"redmineErrors":()=>document.getElementById('errorExplanation')?.innerText||'',
"redmineRequesters":()=>{
  const normalize=s=>s.replace(/\*/g,'').replace(/\s+/g,' ').trim();
  const form=document.getElementById('issue_subject')?.form;
  const label=[...(form?.querySelectorAll('label')||[])].find(l=>normalize(l.textContent)==='Постановщик задачи');
  const field=label&&(document.getElementById(label.htmlFor)||label.querySelector('select'));
  if(field?.tagName!=='SELECT')return {error:'Не найден список постановщиков Redmine.'};
  return [...field.options].filter(o=>o.value&&!o.disabled).map(o=>({value:o.value,label:normalize(o.textContent)}));
}
};
