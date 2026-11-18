// Offscreen documents can use chrome.runtime only. Extension APIs are delegated
// to the service worker through a fixed allowlist; no executable code is sent.
async function extensionRPC(method,args) {
  const r=await chrome.runtime.sendMessage({target:'api',method,args});
  if(!r||r.error)throw Error(r?.error||'Фоновый процесс не отвечает. Повторите запуск.');
  return r.value;
}
globalThis.ExtensionAPI={runtime:chrome.runtime};
for(const [group,methods] of Object.entries({tabs:['query','create','get','update'],storage:[],permissions:['contains','request'],downloads:['download','search'],scripting:['executeScript']})){
  ExtensionAPI[group]={};for(const method of methods)ExtensionAPI[group][method]=(...args)=>extensionRPC(group+'.'+method,args);
}
ExtensionAPI.storage={local:{get:(...args)=>extensionRPC('storage.local.get',args),set:(...args)=>extensionRPC('storage.local.set',args)}};
ExtensionAPI.pageCapture={saveAsMHTML:async details=>{
  const r=await extensionRPC('pageCapture.saveAsMHTML',[details]);
  return new Blob([Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0))],{type:r.type});
}};
