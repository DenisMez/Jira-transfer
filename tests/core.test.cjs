const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../core.js');
const C=global.TransferCore;
test('requester accepts either name order, spacing and a patronymic in the account',()=>{
  const users=[{value:'17',label:'Мезенцев Денис Александрович'},{value:'18',label:'Петров Иван'}];
  assert.equal(C.resolvePerson(users,'Денис Мезенцев').value,'17');
  assert.equal(C.resolvePerson(users,'  мезенцев   ДЕНИС ').value,'17');
  assert.equal(C.resolvePerson(users,'Иван Петров').value,'18');
});
test('unknown, inactive and ambiguous requesters never silently select a different user',()=>{
  assert.throws(()=>C.resolvePerson([],''),/Введите имя/);
  assert.throws(()=>C.resolvePerson([{name:'ivan',displayName:'Иван Петров',active:false}],'Иван Петров'),/не найден/);
  assert.throws(()=>C.resolvePerson([{name:'one',displayName:'Иван Петров'},{name:'two',displayName:'Петров Иван'}],'Иван Петров'),/несколько/);
  assert.equal(C.resolvePerson([{name:'one',displayName:'Иван Петров'},{name:'two',displayName:'Петров Иван'}],'two').name,'two');
});
test('thumbnail resolves to original Jira image attachment with the correct file type',()=>{
  const a={id:'42',mimeType:'image/jpeg',filename:'screen (1).jpg',content:'https://jira.mos.social/secure/attachment/42/screen.jpg'};
  const result=C.imageAsset({src:'/secure/thumbnail/42/preview.png',href:a.content},[a],1,'https://jira.mos.social/browse/X-1');
  assert.deepEqual(result,{url:a.content,name:'image-1.jpg'});
  assert.equal(C.imageMarkup(result.name),'!{width:800px}image-1.jpg!');
});
test('ZIP/PDF attachment icons do not become description image files',()=>{
  const base='https://jira.mos.social/browse/X-1';
  assert.equal(C.imageAsset({src:'/images/icons/attach/zip.gif',href:'/secure/attachment/43/xml.zip',width:'7',height:'7'},[{id:'43',mimeType:'application/zip'}],1,base),null);
  assert.equal(C.imageAsset({src:'/tiny.gif',href:'/secure/attachment/43/xml.zip',width:'7',height:'7'},[],1,base),null);
});
test('real GIF images remain supported and image references cannot contain Textile control syntax',()=>{
  const a={id:'44',mimeType:'image/gif',content:'https://jira.mos.social/secure/attachment/44/diagram.gif'};
  assert.equal(C.imageAsset({src:a.content},[a],2,a.content).name,'image-2.gif');
  assert.throws(()=>C.imageMarkup('screen (1).png'));
});
test('subject id uses only the last five digits of the Jira key',()=>{
  assert.equal(C.parseJira('https://jira.mos.social/browse/KISEMIAS2019-21890').number,'21890');
  assert.equal(C.parseJira('https://jira.mos.social/browse/KISEMIAS2019-123456').number,'23456');
});
test('Redmine hierarchy prefixes and spacing do not change project identity',()=>{
  const options=[{value:'1',label:'»  КИС\u00a0ЕМИАС'},{value:'2',label:'КИС ЕМИАС (внутр)'}];
  assert.equal(C.chooseOption(options,'КИС ЕМИАС').value,'1');
  assert.throws(()=>C.chooseOption([options[1]],'КИС ЕМИАС'),/Доступные варианты/);
  assert.throws(()=>C.chooseOption([...options,options[0]],'КИС ЕМИАС'),/Несколько/);
});
test('description without images produces no image failures',()=>{
  assert.deepEqual(C.failedContentImages([]),[]);
  assert.deepEqual(C.failedContentImages(undefined),[]);
});
test('only unloaded description images require attention',()=>{
  const loaded={url:'https://jira.mos.social/image/1',complete:true,naturalWidth:640};
  const failed={url:'https://jira.mos.social/image/2',complete:true,naturalWidth:0};
  const pending={url:'https://jira.mos.social/image/3',complete:false,naturalWidth:640};
  assert.deepEqual(C.failedContentImages([loaded,failed,pending]),[failed,pending]);
});
test('Jira URL extracts the public key number, not internal id',()=>{
  assert.deepEqual(C.parseJira('https://jira.mos.social/browse/KISEMIAS2019-21925?x=1'),{
    url:'https://jira.mos.social/browse/KISEMIAS2019-21925',key:'KISEMIAS2019-21925',number:'21925',origin:'https://jira.mos.social'});
});
test('wrong hosts, credentials, local URLs and unrelated paths cannot be Jira sources',()=>{
  for(const u of ['https://jira.mos.social.evil.test/browse/X-1','http://jira.mos.social/browse/X-1','https://user:password@jira.mos.social/browse/X-1','file:///browse/X-1','https://jira.mos.social/login'])assert.throws(()=>C.parseJira(u));
});
test('deadline validates actual calendar dates',()=>{
  assert.equal(C.validateDate('2028-02-29'),'2028-02-29');
  for(const d of ['2026-02-29','2026-13-01','23.11.2026',''])assert.throws(()=>C.validateDate(d));
});
test('archive filenames cannot add directories or Windows-special characters',()=>{
  assert.equal(C.safeName('../page:test?.'),'.._page_test_');
  assert(!/[<>:"/\\|?*]/.test(C.safeName('a/b\\c:d*e?f')));
  assert.equal(C.safeName(''),'page');
});
test('linked pages resolve relative links and reject executable URLs',()=>{
  assert.equal(C.webURL('/browse/X-2#tab','https://jira.mos.social/browse/X-1'),'https://jira.mos.social/browse/X-2');
  for(const u of ['javascript:alert(1)','file:///etc/passwd','data:text/html,test','https://a:b@example.com'])assert.throws(()=>C.webURL(u));
});
