// Development utility: extract self-contained injected functions into a static,
// CSP-compatible registry. No runtime eval or dynamic code compilation is used
// by the extension. Node's bundled parser is used only during development.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const context={exports:{}};
vm.runInNewContext(process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'],context);
const file=path.join(__dirname,'../app.js'),code=fs.readFileSync(file,'utf8');
const tree=(context.acorn||context.exports).parse(code,{ecmaVersion:'latest',sourceType:'script'});
const calls=[];
function visit(n){if(!n||typeof n!=='object')return;if(n.type==='CallExpression'&&n.callee.name==='inTab'&&['ArrowFunctionExpression','FunctionExpression'].includes(n.arguments[1]?.type))calls.push(n.arguments[1]);for(const [k,v]of Object.entries(n)){if(k==='start'||k==='end')continue;if(Array.isArray(v))v.forEach(visit);else if(v&&typeof v==='object')visit(v);}}
visit(tree);calls.sort((a,b)=>a.start-b.start);
if(!calls.length)process.exit(0);
const names=['fetchSource','inspectArchive','localRequest','redmineOptions','selectRedmine','fillRedmine','submitRedmine','verifyRedmine','redmineErrors'];
if(calls.length!==names.length)throw Error('Review injection registry names before extracting.');
fs.writeFileSync(path.join(__dirname,'../injected.js'),'// Static functions executed in website tabs; no extension state is captured.\nglobalThis.Injected={\n'+calls.map((n,i)=>JSON.stringify(names[i])+':'+code.slice(n.start,n.end)).join(',\n')+'\n};\n');
let result=code;for(let i=calls.length-1;i>=0;i--)result=result.slice(0,calls[i].start)+JSON.stringify(names[i])+result.slice(calls[i].end);
fs.writeFileSync(file,result);
