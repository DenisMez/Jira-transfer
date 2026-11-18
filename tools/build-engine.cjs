const fs=require('node:fs'),path=require('node:path');const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace('<script src="full.js"></script>','<script src="rpc.js"></script><script src="updates.js"></script><script src="app.js"></script>');
fs.writeFileSync(path.join(root,'engine.html'),html);
