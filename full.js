'use strict';
const $=id=>document.getElementById(id);
const fields=['source','date','destination','localType','localPriority','localDeadline','redmine','project','tracker','priority','requester','deadlineLabel'];
let snapshot,initialized=false,revision,polling=false,requesting=false;
async function send(command,data){const r=await chrome.runtime.sendMessage({target:'controller',command,data});if(!r||r.error)throw Error(r?.error||'Фоновый процесс не отвечает.');return r;}
function input(){return {...Object.fromEntries(fields.map(id=>[id,$(id).value])),extra:$('extra').value,selected:[...$('links').querySelectorAll('input:checked')].map(e=>e.value),existing:$('existing').value,checked:$('checked').checked};}
function paint(s){
  snapshot=s;
  if(!initialized){for(const id of fields)if(s.settings?.[id])$(id).value=s.settings[id];$('extra').value=s.extra||'';initialized=true;}
  $('status').textContent=s.status||'Готово к работе';$('log').textContent=s.log||'';
  const skipped=s.skippedPages||[];$('skipped').hidden=!skipped.length;$('skippedLinks').replaceChildren();
  for(const page of skipped){const item=document.createElement('li'),link=document.createElement('a');link.textContent=page.url;link.href=page.url;link.target='_blank';link.rel='noreferrer';item.append(link,document.createTextNode(' — '+page.reason));$('skippedLinks').append(item);}
  $('preview').hidden=!s.issue;
  if(s.issue&&s.issue.revision!==revision){
    revision=s.issue.revision;$('subject').textContent=s.issue.subject;$('links').replaceChildren();
    for(const url of s.issue.links){const label=document.createElement('label'),box=document.createElement('input');box.type='checkbox';box.value=url;box.checked=s.selected.includes(url);label.append(box,document.createTextNode(' '+url));$('links').append(label);}
  }
  $('description').textContent=s.description||'';$('warnings').textContent=s.warnings||'';
  for(const [id,values] of [['projects',s.projects||[]],['localTypes',s.localTypes||[]]]){const d=$(id);d.replaceChildren();for(const v of values){const o=document.createElement('option');o.value=v;d.append(o);}}
  const same=(s.jobDestination||'redmine')===$('destination').value;
  $('result').hidden=!s.result||!same;if(s.result)$('result').href=s.result;
  $('uncertain').hidden=s.stage!=='sending'||s.busy;
  document.querySelectorAll('button,input,select,textarea').forEach(e=>e.disabled=!!s.busy||requesting);
  $('run').disabled=!!s.busy||requesting||s.stage==='sending';
}
async function refresh(){if(polling||requesting)return;polling=true;try{const s=await send('snapshot');if(s.ready)paint(s);}catch(e){$('status').textContent=e.message;}finally{polling=false;}}
async function action(command){
  if(requesting||snapshot?.busy)return;requesting=true;
  try{
    if(command==='transfer'){
      const data=input(),urls=[snapshot.issue.url,...snapshot.issue.images,...data.selected,...data.extra.split(/\r?\n/).filter(u=>u.trim()).map(u=>TransferCore.webURL(u))];
      if(data.destination==='jira')urls.push('http://jira.oblteh:8080/');
      if(!await chrome.permissions.request({origins:[...new Set(urls.map(u=>new URL(u).origin+'/*'))]}))throw Error('Нужен доступ к выбранным страницам.');
    }
    await send(command,input());
  }catch(e){$('status').textContent=e.message;}finally{requesting=false;}
}
for(const [id,command] of [['read','read'],['run','transfer'],['loadProjects','loadProjects'],['loadLocal','loadLocal'],['markDone','markDone'],['unlock','unlock'],['reset','reset']])$(id).onclick=()=>action(command);
for(const id of fields)$(id).onchange=()=>send('configure',input()).catch(e=>{$('status').textContent=e.message;});
void refresh();setInterval(refresh,1000);
