/* Pure helpers are shared with the local tests. */
globalThis.TransferCore = {
  unavailableArchiveReason(error) {
    const text=String(error?.message||error||'');
    if(/Frame with ID \d+ is showing error page|chrome-error:\/\//i.test(text))return 'Сайт не открылся: Chrome показал страницу ошибки.';
    if(/net::ERR_[A-Z_]+|ERR_(?:NAME_NOT_RESOLVED|CONNECTION_[A-Z_]+|TIMED_OUT|CERT_[A-Z_]+)/i.test(text))return 'Сайт недоступен из-за ошибки подключения или сертификата.';
    if(/Страница долго загружается/i.test(text))return 'Сайт не загрузился за отведённое время.';
    if(/No tab with id|tab (?:was |is )?closed|No frame with id|frame (?:was |is )?removed/i.test(text))return 'Вкладка страницы закрыта или недоступна.';
    return null;
  },
  issueIdentity(subject) {
    const text=String(subject||'').normalize('NFC').replace(/\s+/g,' ').trim();
    const match=text.match(/^(.*?)(?:\s*\[(\d{5})\]|\s+(\d{5}))$/);
    if(!match)return null;
    return {title:match[1].trim(),number:match[2]||match[3]};
  },
  pickExisting(candidates,subject,source) {
    const expected=this.issueIdentity(subject);if(!expected)throw Error('В конце названия ожидается номер Jira из пяти цифр.');
    const matches=[...new Map(candidates.filter(item=>{
      const identity=this.issueIdentity(item.subject);return identity&&identity.number===expected.number;
    }).map(item=>[String(item.key||item.id),item])).values()];
    if(matches.length>1)throw Error('Найдено несколько задач с номером ['+expected.number+']: '+matches.map(i=>i.url||i.key||i.id).join('; ')+'. Новая задача не создаётся. Оставьте одну актуальную задачу перед повтором.');
    const result=matches[0]||null;
    if(result?.description){
      const sources=[...result.description.matchAll(/(?:Ссылка на Jira|Первоисточник):\s*(https:\/\/jira\.mos\.social\/browse\/[A-Z][A-Z0-9_]*-\d+)/gi)].map(m=>m[1]);
      if(sources.length&&!sources.includes(source))throw Error('У найденной задачи указан другой первоисточник Jira. Обновление остановлено.');
    }
    return result;
  },
  versionedFileName(name,hash) {
    if(!/^[a-f0-9]{64}$/.test(hash))throw Error('Не удалось вычислить контрольную сумму вложения.');
    const dot=name.lastIndexOf('.');if(dot<1)throw Error('У файла нет расширения: '+name);
    return name.slice(0,dot)+'-'+hash.slice(0,20)+name.slice(dot);
  },
  localUpdatePayload(fields,s,description,reporter,summary) {
    if(!fields.summary||!fields.description)throw Error('В локальной Jira недоступно изменение названия или описания.');
    const relaxed=Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,{...v,required:false}]));
    const payload=this.localPayload({fields:relaxed}, {...s,localPriority:''},description,reporter,summary);
    delete payload.fields.project;delete payload.fields.issuetype;
    return payload;
  },
  personMatches(displayName,wanted) {
    const tokens=s=>String(s||'').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g,'е').trim().split(/\s+/).filter(Boolean).sort();
    const name=tokens(displayName),query=tokens(wanted);
    if(query.length<2||query.length>name.length||name.length>3)return false;
    const remaining=[...name];
    return query.every(t=>{const index=remaining.indexOf(t);if(index<0)return false;remaining.splice(index,1);return true;});
  },
  resolvePerson(users,wanted) {
    const query=String(wanted||'').trim();if(!query)throw Error('Введите имя и фамилию постановщика.');
    const candidates=users.filter(u=>u.active!==false&&(String(u.name||u.value||'').toLowerCase()===query.toLowerCase()||this.personMatches(u.displayName||u.label,query)));
    if(candidates.length===1)return candidates[0];
    if(candidates.length>1)throw Error('Найдено несколько пользователей «'+query+'». Уточните полное имя или логин: '+candidates.map(u=>(u.displayName||u.label)+' ['+(u.name||u.value)+']').join('; '));
    throw Error('Постановщик «'+query+'» не найден в системе назначения. Проверьте имя и доступные учётные записи.');
  },
  destinationOf(job) {return job?.destination||'redmine';},
  completionKey(source,destination) {return destination+'|'+source;},
  jiraDescription(raw,aliases,attachments,source) {
    if(typeof raw!=='string')throw Error('Эта версия поддерживает Wiki-разметку Jira Server.');
    const text=raw.replace(/!([^!\n]+)!/g,(whole,body)=>{
      const reference=body.split('|')[0].trim();
      let name=aliases[reference];
      if(name===undefined){try{name=aliases[decodeURIComponent(reference.replace(/^\^/,''))];}catch{}}
      if(name)return '!'+name+'|width=800!';
      if(name===null)return '';
      if(/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(reference)||/^https?:\/\//.test(reference))throw Error('Не удалось сопоставить изображение из Wiki-разметки: '+reference);
      return whole;
    }).replace(/\[([^\]\n]+)\]/g,(whole,body)=>{
      const parts=body.split('|'),target=parts[parts.length-1];
      if(target.startsWith('^')) {
        const a=attachments.find(a=>a.filename===target.slice(1));
        return a?'['+(parts.length>1?parts.slice(0,-1).join('|'):a.filename)+'|'+a.content+']':whole;
      }
      if(/^[A-Z][A-Z0-9_]*-\d+$/.test(target))return '['+(parts.length>1?parts.slice(0,-1).join('|'):target)+'|'+new URL(source).origin+'/browse/'+target+']';
      return whole;
    });
    return text+'\n\nПервоисточник: '+source;
  },
  localPayload(meta,s,description,me,summary) {
    const f=meta.fields||{};
    if(f.description?.schema?.type==='object')throw Error('Локальная Jira требует другой формат описания.');
    const fields={project:{key:'KIS'},issuetype:{id:meta.id},summary,description};
    const dateField=f[s.localDeadline]?[s.localDeadline]:Object.keys(f).filter(k=>f[k].name===s.localDeadline);
    if(dateField.length!==1)throw Error('Не найдено поле срока «'+s.localDeadline+'». Доступные поля: '+Object.entries(f).map(([k,v])=>v.name+' ('+k+')').join('; '));
    const key=dateField[0];
    if(key!=='duedate'&&!['date','datetime'].includes(f[key].schema?.type))throw Error('Выбранное поле срока не является датой.');
    fields[key]=f[key].schema?.type==='datetime'?s.date+'T00:00:00.000+0300':s.date;
    if(f.reporter&&me?.name)fields.reporter={name:me.name};
    if(s.localPriority) {
      const match=(f.priority?.allowedValues||[]).filter(p=>p.name===s.localPriority||p.id===s.localPriority);
      if(match.length!==1)throw Error('Приоритет недоступен: '+s.localPriority);fields.priority={id:match[0].id};
    }
    const missing=[];
    for(const [k,v] of Object.entries(f))if(v.required&&fields[k]===undefined&&k!=='attachment'){
      if(v.defaultValue!==undefined&&v.defaultValue!==null)fields[k]=v.defaultValue;
      else if(!v.hasDefaultValue)missing.push(v.name||k);
    }
    if(missing.length)throw Error('В локальной Jira обязательны дополнительные поля: '+missing.join(', ')+'. Нужна настройка переноса до создания задачи.');
    return {fields};
  },
  imageAsset(meta,attachments,index,base) {
    const src=this.webURL(meta.src,base);
    const id=u=>{try{return new URL(u,base).pathname.match(/\/(?:attachment|thumbnail)\/(\d+)(?:\/|$)/)?.[1];}catch{return null;}};
    const attachment=(attachments||[]).find(a=>String(a.id)===id(src)) ||
      (attachments||[]).find(a=>String(a.id)===id(meta.href));
    // A file-type icon inside a ZIP/PDF link is not an image in the specification.
    if(attachment?.mimeType && !attachment.mimeType.startsWith('image/'))return null;
    if(!attachment && (/\/images\/(?:icons|attach|attachment|aui)\//i.test(src) ||
      (Number(meta.width)>0 && Number(meta.width)<=24 && Number(meta.height)>0 && Number(meta.height)<=24 && /\.(zip|pdf|docx?|xlsx?|xml)(?:[?#]|$)/i.test(meta.href||''))))return null;
    const url=attachment?.content?this.webURL(attachment.content,base):
      (/\/secure\/attachment\/\d+\//.test(meta.href||'') && /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#]|$)/i.test(meta.href)?this.webURL(meta.href,base):src);
    const ext=({'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/bmp':'bmp','image/svg+xml':'svg'})[attachment?.mimeType] ||
      (attachment?.filename||new URL(url).pathname).match(/\.(png|jpe?g|gif|webp|bmp|svg)$/i)?.[1]?.toLowerCase() || 'png';
    return {url,name:`image-${index}.${ext}`};
  },
  imageMarkup(name) {
    if(!/^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name))throw Error('Недопустимое имя изображения: '+name);
    return `!{width:800px}${name}!`;
  },
  chooseOption(options,wanted) {
    const norm=s=>String(s).normalize('NFKC').replace(/\u00a0/g,' ').replace(/^[\s»›>\-–—]+/,'').replace(/\s+/g,' ').trim().toLocaleLowerCase('ru');
    const matches=options.filter(o=>o.value && !o.disabled && norm(o.label)===norm(wanted));
    if(matches.length===1)return matches[0];
    if(matches.length>1)throw Error('Несколько вариантов с названием «'+wanted+'». Нужен выбор по ID проекта.');
    throw Error('Не найдено «'+wanted+'». Доступные варианты: '+options.filter(o=>o.value&&!o.disabled).map(o=>o.label).join('; '));
  },
  failedContentImages(images) {
    return (images || []).filter(i=>!i.complete || !(i.naturalWidth>0));
  },
  parseJira(value) {
    const u = new URL(value.trim());
    const m = u.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]*-([0-9]+))\/?$/i);
    if (u.protocol !== 'https:' || u.hostname !== 'jira.mos.social' || !m || u.username || u.password)
      throw Error('Нужна ссылка https://jira.mos.social/browse/ПРОЕКТ-НОМЕР');
    return {url: `${u.origin}/browse/${m[1].toUpperCase()}`, key: m[1].toUpperCase(), number: m[2].slice(-5), origin:u.origin};
  },
  safeName(s) { return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g,'').slice(0,120) || 'page'; },
  validateDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s).toISOString().slice(0,10)!==s) throw Error('Укажите корректную дату «Выполнить до».');
    return s;
  },
  webURL(value, base) {
    const u = new URL(value,base);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw Error('Разрешены только HTTP/HTTPS ссылки без пароля.');
    u.hash=''; return u.href;
  }
};
