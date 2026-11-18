importScripts('injected.js');
let starting;
async function runner() {
  if(starting)return starting;
  starting=(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT'],documentUrls:[chrome.runtime.getURL('engine.html')]});
    if(!contexts.length)await chrome.offscreen.createDocument({url:'engine.html',reasons:['DOM_PARSER','BLOBS'],justification:'Разбор описаний Jira и работа с MHTML и изображениями без открытия вкладки утилиты.'});
    for(let i=0;i<60;i++){
      try{const r=await chrome.runtime.sendMessage({target:'runner',command:'snapshot'});if(r?.ready)return;}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw Error('Невидимый рабочий процесс не ответил. Обновите расширение.');
  })();
  try{return await starting;}finally{starting=undefined;}
}
async function callAPI(method,args) {
  if(method==='scripting.executeScript') {
    const options=args[0];
    if(!Object.hasOwn(Injected,options.func))throw Error('Неизвестная операция страницы.');
    return chrome.scripting.executeScript({...options,func:Injected[options.func]});
  }
  if(method==='pageCapture.saveAsMHTML') {
    const blob=await chrome.pageCapture.saveAsMHTML(args[0]);if(!blob)throw Error('Не удалось получить MHTML.');
    const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));
    return {base64:btoa(binary),type:blob.type};
  }
  if(method==='permissions.request')throw Error('Откройте окно утилиты и разрешите доступ к выбранным страницам кнопкой «Перенести».');
  const allowed=['storage.local.get','storage.local.set','tabs.query','tabs.create','tabs.get','tabs.update','permissions.contains','downloads.download','downloads.search'];
  if(!allowed.includes(method))throw Error('Операция не разрешена.');
  const parts=method.split('.');let object=chrome;for(const part of parts.slice(0,-1))object=object[part];
  return object[parts.at(-1)](...args);
}
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(message?.target==='api'){
    if(sender.url!==chrome.runtime.getURL('engine.html')){respond({error:'Недопустимый отправитель.'});return;}
    callAPI(message.method,message.args||[]).then(value=>respond({value:value??null}),e=>respond({error:e.message}));return true;
  }
  if(message?.target!=='controller')return;
  (async()=>{
    if(message.command==='open') {
      const url=chrome.runtime.getURL('index.html');const tabs=await chrome.tabs.query({url});
      if(tabs.length){await chrome.tabs.update(tabs[0].id,{active:true});await chrome.windows.update(tabs[0].windowId,{focused:true});}
      else await chrome.tabs.create({url,active:true});
      return {ok:true};
    }
    await runner();return chrome.runtime.sendMessage({...message,target:'runner'});
  })().then(respond,e=>respond({error:e.message}));return true;
});
