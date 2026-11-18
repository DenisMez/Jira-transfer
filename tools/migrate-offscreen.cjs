const fs=require('node:fs'),path=require('node:path');
const file=path.join(__dirname,'../app.js');let code=fs.readFileSync(file,'utf8');
code=code.replace(/chrome\./g,'API.');
if(!code.includes('const API ='))code=code.replace('const C = TransferCore;','const C = TransferCore;\nconst API = globalThis.ExtensionAPI || chrome;');
code=code.replace('    const tab=await API.tabs.getCurrent();\n    if(tab?.id!==message.tabId)return null;\n','');
fs.writeFileSync(file,code);
