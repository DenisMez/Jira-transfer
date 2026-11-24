'use strict';
const $=id=>document.getElementById(id);
let snapshot,revision,initialized=false,polling=false,requesting=false,draft={};
async function send(command,data) {
  const r=await chrome.runtime.sendMessage({target:'controller',command,data});
  if(!r)throw Error('Рабочая вкладка не отвечает. Откройте настройки.');
  if(r.error)throw Error(r.error);
  return r;
}
function selected() {return [...$('links').querySelectorAll('input:checked')].map(e=>e.value);}
function remember() {
  draft={source:$('source').value,date:$('date').value,requester:$('requester').value,destination:$('destination').value,extra:$('extra').value,selected:selected(),revision};
  void chrome.storage.local.set({popupDraft:draft});
}
function paint(s) {
  snapshot=s;
  if(!initialized) {
    $('source').value=draft.source??s.settings?.source??'';
    $('date').value=draft.date??s.settings?.date??'';
    $('requester').value=draft.requester??s.settings?.requester??'';
    $('extra').value=draft.extra??s.extra??'';
    $('destination').value=draft.destination??s.settings?.destination??'redmine';
    initialized=true;
  }
  $('status').textContent=s.status||(s.busy?'Выполняется перенос…':'Готово к работе');
  $('log').textContent=s.log||'';
  const skipped=s.skippedPages||[];$('skipped').hidden=!skipped.length;$('skippedLinks').replaceChildren();
  for(const page of skipped){const item=document.createElement('li'),link=document.createElement('a');link.textContent=page.url;link.href=page.url;link.target='_blank';link.rel='noreferrer';item.append(link,document.createTextNode(' — '+page.reason));$('skippedLinks').append(item);}
  $('dot').className=s.busy?'running':'';
  $('uncertain').hidden=s.stage!=='sending'||s.busy;
  const sameDestination=(s.jobDestination||'redmine')===$('destination').value;
  $('result').hidden=!s.result||!sameDestination;if(s.result)$('result').href=s.result;
  $('preview').hidden=!s.issue;
  if(s.issue && revision!==s.issue.revision) {
    revision=s.issue.revision;$('subject').textContent=s.issue.subject;$('links').replaceChildren();
    const checked=draft.revision===revision?draft.selected:s.selected;
    for(const url of s.issue.links) {
      const label=document.createElement('label'),box=document.createElement('input');
      box.type='checkbox';box.value=url;box.checked=checked?checked.includes(url):true;
      box.onchange=remember;label.append(box,document.createTextNode(url));$('links').append(label);
    }
  }
  $('read').disabled=requesting||s.busy||s.stage==='sending';
  $('run').disabled=requesting||s.busy||s.stage==='sending';
  $('reset').disabled=requesting||s.busy;
  for(const id of ['source','date','requester','extra','destination'])$(id).disabled=s.busy;
  $('links').querySelectorAll('input').forEach(e=>e.disabled=s.busy);
}
async function refresh() {
  if(polling||requesting)return;polling=true;
  try{const s=await send('snapshot');if(s.ready)paint(s);}catch(e){$('status').textContent=e.message;}
  finally{polling=false;}
}
async function act(command) {
  if(requesting||snapshot?.busy)return;
  requesting=true;$('read').disabled=true;$('run').disabled=true;
  try {
    TransferCore.parseJira($('source').value);TransferCore.validateDate($('date').value);
    if(command==='transfer') {
      if(!snapshot?.issue)throw Error('Сначала прочитайте задачу.');
      const urls=[snapshot.issue.url,...snapshot.issue.images,...selected(),...$('extra').value.split(/\r?\n/).filter(u=>u.trim()).map(u=>TransferCore.webURL(u))];
      if($('destination').value==='jira')urls.push('http://jira.oblteh:8080/');
      const origins=[...new Set(urls.map(u=>new URL(u).origin+'/*'))];
      // This permission request belongs to the actual popup button gesture.
      if(!await chrome.permissions.request({origins}))throw Error('Разрешите доступ к выбранным страницам для сохранения архивов.');
    }
    remember();
    await send(command,{source:$('source').value,date:$('date').value,requester:$('requester').value,destination:$('destination').value,extra:$('extra').value,selected:selected()});
    $('status').textContent=command==='read'?'Читаю задачу…':'Перенос запущен. Окно можно закрыть.';
  }catch(e){$('status').textContent=e.message;}
  finally{requesting=false;if(snapshot)paint({...snapshot,status:$('status').textContent});}
}
$('read').onclick=()=>act('read');$('run').onclick=()=>act('transfer');
$('reset').onclick=async()=>{
  if(requesting||snapshot?.busy)return;
  requesting=true;$('reset').disabled=true;
  try{
    const r=await send('reset');
    if(r.ok){revision=undefined;draft.revision=undefined;remember();}
  }catch(e){$('status').textContent=e.message;}
  finally{requesting=false;await refresh();}
};
$('open').onclick=()=>send('open').catch(e=>{$('status').textContent=e.message;});
for(const id of ['source','date','requester','extra'])$(id).oninput=remember;
$('destination').onchange=()=>{remember();if(snapshot)paint(snapshot);};
(async()=>{
  const state=await chrome.storage.local.get('popupDraft');draft=state.popupDraft||{};
  await refresh();setInterval(refresh,1000);
})().catch(e=>{$('status').textContent=e.message;});
