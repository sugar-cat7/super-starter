import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const root=process.cwd();
const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:64*1024*1024});
const state=JSON.parse(fs.readFileSync('.template.json','utf8'));
const refs=git('rev-list','--objects','--all').toString().trim().split('\n').map(x=>x.split(' ')[0]);
const objects=[...new Set(refs)].map(sha=>({sha,type:git('cat-file','-t',sha).toString().trim(),bytes:git('cat-file','-p',sha).toString('base64')}));
for(const object of objects) if(object.type==='tree') object.bytes=git('cat-file','tree',object.sha).toString('base64');
const tracked=git('ls-tree','-r','-z','HEAD').toString().split('\0').filter(Boolean).map(row=>{const [header,file]=row.split('\t');const [mode,type,sha]=header.split(' ');return {path:file,mode,type,sha,bytes:git('cat-file','blob',sha).toString('base64')};});
const input=crypto.createHash('sha256');for(const file of tracked){input.update(file.path);input.update('\0');input.update(Buffer.from(file.bytes,'base64'));}
const report={version:1,kind:process.argv[2]??'pristine',sourceOrigin:state.origin,template:state,head:git('rev-parse','HEAD').toString().trim(),trackedContentId:input.digest('hex'),objects,tracked};
const bytes=Buffer.from(JSON.stringify(report));const digest=crypto.createHash('sha256').update(bytes).digest('hex');
fs.mkdirSync('artifacts/actor',{recursive:true});fs.writeFileSync('artifacts/actor/'+report.kind+'-raw-git.json',bytes);
const b64=bytes.toString('base64');for(let i=0;i<b64.length;i+=30000)console.log('ACTOR_CHUNK '+JSON.stringify({kind:report.kind,sha256:digest,bytes:bytes.length,index:i/30000,total:Math.ceil(b64.length/30000),data:b64.slice(i,i+30000)}));
console.log('ACTOR_SUMMARY '+JSON.stringify({...report,objects:objects.map(({sha,type})=>({sha,type})),tracked:tracked.map(({path,sha,mode})=>({path,sha,mode}))}));
if(process.argv[3]==='inspect')for(const file of tracked.filter(x=>x.path.startsWith('packages/desktop/')||['package.json','tools/quality/definitions.ts','tools/quality/gate.ts','tools/quality/native.ts','tools/dev-environment/dev.ts','tools/errors/catalog.json','docs/errors.md'].includes(x.path))) console.log('ACTOR_FILE '+JSON.stringify({path:file.path,content:Buffer.from(file.bytes,'base64').toString('utf8')}));
